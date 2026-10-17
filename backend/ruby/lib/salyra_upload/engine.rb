require 'json'
require 'digest'
module SalyraUpload
  class UploadError < StandardError
    attr_reader :status, :code
    def initialize(status, code, message)
      super(message)
      @status, @code = status, code
    end
  end

  # Storage and SessionStore are duck-typed contracts with explicit streaming methods.
  class Engine
    attr_reader :sessions, :storage
    def initialize(sessions:, storage:, ttl: 86_400, max_file_size: nil, max_chunk_size: 64 * 1024 * 1024, scope: nil, authorize: nil, allow_anonymous: false, validate: nil, notify: nil, notification_error: nil)
      # without authorize anyone who reaches the routes can create, read and finish uploads
      if authorize.nil? && !allow_anonymous
        raise ArgumentError, 'Provide authorize (and scope) from your authentication, or allow_anonymous: true for a local demo'
      end
      @sessions, @storage = sessions, storage
      @ttl, @max_file_size, @max_chunk_size = ttl, max_file_size, max_chunk_size
      @scope, @authorize, @validate, @notify, @notification_error = scope, authorize, validate, notify, notification_error
    end
    def authorize(operation, session, context)
      @authorize&.call(operation, session, context)
    end
    def notify(type, session, context, part = nil)
      @notify&.call({ 'id' => "#{session['id']}:#{type}#{part ? ":#{part['index']}" : ''}", 'type' => type, 'session' => session, 'part' => part }, context)
    rescue StandardError => error
      @notification_error&.call(error)
    end
    def count(descriptor)
      [1, (descriptor['size'] + descriptor['chunkSize'] - 1) / descriptor['chunkSize']].max
    end
    def create_upload(descriptor, key, context = nil)
      authorize('create', nil, context)
      raise UploadError.new(400, 'DESCRIPTOR', 'Invalid upload configuration') unless descriptor.is_a?(Hash)
      integers = %w[size lastModified chunkSize].all? { |field| descriptor[field].is_a?(Integer) && descriptor[field].between?(0, 9_007_199_254_740_991) }
      unless integers && descriptor['protocol'] == 'salyra-upload/1' && descriptor['name'].is_a?(String) && descriptor['name'].length <= 1024 && descriptor['type'].is_a?(String) && descriptor['chunkSize'].between?(1, @max_chunk_size) && key.is_a?(String) && key.length.between?(1, 200)
        raise UploadError.new(400, 'DESCRIPTOR', 'Invalid upload configuration')
      end
      raise UploadError.new(413, 'FILE_SIZE', 'File exceeds its limit') if (@max_file_size && descriptor['size'] > @max_file_size) || count(descriptor) > 100_000
      @validate&.call(descriptor, context)
      identifier = Digest::SHA256.hexdigest(JSON.generate([@scope&.call(context) || '', key]))
      sessions.transaction(identifier) do
        existing = sessions.get(identifier)
        if existing
          authorize('create', existing, context)
          raise UploadError.new(409, 'KEY_CONFLICT', 'Key belongs to another file') unless existing['descriptor'] == descriptor
          reconcile(existing, context) if existing['expiresAt'] <= Time.now.to_f * 1000 && existing['state'] == 'finalizing'
          raise UploadError.new(410, 'EXPIRED', 'Session expired') if existing['expiresAt'] <= Time.now.to_f * 1000 && existing['state'] != 'completed'
          next { 'id' => identifier, 'chunkSize' => descriptor['chunkSize'], 'expiresAt' => existing['expiresAt'] }
        end
        session = { 'id' => identifier, 'descriptor' => descriptor, 'expiresAt' => ((Time.now.to_f + @ttl) * 1000).to_i, 'state' => 'open', 'parts' => [] }
        session['storageRef'] = storage.begin(session, context)
        sessions.save(session)
        notify('created', session, context)
        { 'id' => identifier, 'chunkSize' => descriptor['chunkSize'], 'expiresAt' => session['expiresAt'] }
      end
    end
    def get(identifier, operation, context)
      session = sessions.get(identifier)
      raise UploadError.new(404, 'NOT_FOUND', 'Upload session was not found') unless session
      authorize(operation, session, context)
      raise UploadError.new(410, 'EXPIRED', 'Session expired') if session['state'] == 'expired'
      if session['expiresAt'] <= Time.now.to_f * 1000 && !%w[completed canceled].include?(session['state'])
        if session['state'] == 'finalizing'
          reconcile(session, context)
          return session if session['state'] == 'completed'
        end
        storage.abort(session, context)
        session['state'] = 'expired'
        sessions.save(session)
        notify('expired', session, context)
        raise UploadError.new(410, 'EXPIRED', 'Session expired')
      end
      session
    end
    def reconcile(session, context)
      return if %w[completed canceled].include?(session['state'])
      result = storage.inspect_result(session, context)
      if result
        session['state'], session['result'] = 'completed', result
      else
        parts = storage.probe(session, context).sort_by { |part| part['index'] }
        descriptor = session['descriptor']
        seen = {}
        parts.each do |part|
          index = part['index']
          expected = [descriptor['chunkSize'], descriptor['size'] - index * descriptor['chunkSize']].min
          raise UploadError.new(500, 'STORAGE_CHECKPOINT', 'Storage returned an invalid part') if seen[index] || !index.between?(0, count(descriptor) - 1) || part['size'] != expected
          seen[index] = true
        end
        session['parts'] = parts
      end
      sessions.save(session)
    end
    def get_upload(identifier, context = nil)
      sessions.transaction(identifier) do
        session = get(identifier, 'probe', context)
        reconcile(session, context)
        result = { 'status' => session['state'], 'parts' => session['parts'].map { |part| part.slice('index', 'size', 'sha256') }, 'expiresAt' => session['expiresAt'] }
        result['result'] = session['result'] if session['state'] == 'completed'
        result
      end
    end
    def receive_part(identifier, index, checksum, body, context = nil)
      sessions.transaction(identifier) do
        session = get(identifier, 'part', context)
        raise UploadError.new(409, 'STATE', 'Upload does not accept chunks') unless session['state'] == 'open'
        descriptor = session['descriptor']
        unless index.is_a?(Integer) && index.between?(0, count(descriptor) - 1) && checksum.match?(/\A[a-f0-9]{64}\z/)
          raise UploadError.new(400, 'PART', 'Invalid chunk or checksum')
        end
        part = { 'index' => index, 'size' => [descriptor['chunkSize'], descriptor['size'] - index * descriptor['chunkSize']].min, 'sha256' => checksum }
        saved = storage.write_part(session, part, body, context)
        session['parts'] = (session['parts'].reject { |p| p['index'] == index } + [saved]).sort_by { |p| p['index'] }
        sessions.save(session)
        notify('part-stored', session, context, saved)
        saved.slice('index', 'size', 'sha256')
      end
    end
    def finish_upload(identifier, context = nil)
      sessions.transaction(identifier) do
        session = get(identifier, 'complete', context)
        reconcile(session, context)
        next session['result'] if session['state'] == 'completed'
        raise UploadError.new(409, 'CANCELED', 'Upload was canceled') if session['state'] == 'canceled'
        unless session['parts'].length == count(session['descriptor']) && session['parts'].each_with_index.all? { |p, index| p['index'] == index }
          raise UploadError.new(409, 'INCOMPLETE', 'Upload is missing chunks')
        end
        session['state'] = 'finalizing'
        sessions.save(session)
        begin
          result = storage.finish(session, session['parts'], context)
        rescue StandardError
          result = storage.inspect_result(session, context)
          raise unless result
        end
        session['state'], session['result'] = 'completed', result
        sessions.save(session)
        notify('completed', session, context)
        result
      end
    end
    def cancel_upload(identifier, context = nil)
      sessions.transaction(identifier) do
        session = get(identifier, 'cancel', context)
        reconcile(session, context)
        raise UploadError.new(409, 'COMPLETED', 'Remove completed files through the application') if session['state'] == 'completed'
        storage.abort(session, context)
        session['state'], session['parts'] = 'canceled', []
        sessions.save(session)
        notify('canceled', session, context)
        nil
      end
    end
  end
end
