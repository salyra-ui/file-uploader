module SalyraUpload
  class RackApp
    def initialize(engine, base_path: '/uploads', match: nil)
      @engine, @base_path, @match = engine, base_path, match
    end
    def call(environment)
      method, path = environment['REQUEST_METHOD'], environment['PATH_INFO']
      if @match
        operation, identifier, index = @match.call(environment)
      elsif path == @base_path && method == 'POST'
        operation = 'create'
      elsif (route = path.match(/\A#{Regexp.escape(@base_path)}\/([a-zA-Z0-9_-]{1,100})(?:\/parts\/(\d+)|\/(complete))?\z/))
        identifier, number, complete = route.captures
        operation = if number && method == 'PUT' then 'part'
                    elsif complete && method == 'POST' then 'complete'
                    elsif !number && !complete && method == 'GET' then 'probe'
                    elsif !number && !complete && method == 'DELETE' then 'cancel'
                    end
        index = number&.to_i
      end
      raise UploadError.new(404, 'NOT_FOUND', 'Route was not found') unless operation
      body = environment['rack.input']
      result = case operation
               when 'create'
                 # a cross-site form can post text/plain without a CORS preflight, not this type
                 media = (environment['CONTENT_TYPE'] || environment['HTTP_CONTENT_TYPE']).to_s.split(';').first.to_s.strip.downcase
                 raise UploadError.new(415, 'CONTENT_TYPE', 'Upload metadata must be sent as application/json') unless media == 'application/json'
                 bytes = body.read(65_537)
                 raise UploadError.new(413, 'JSON_SIZE', 'Upload metadata is too large') if bytes.bytesize > 65_536
                 @engine.create_upload(JSON.parse(bytes), environment['HTTP_IDEMPOTENCY_KEY'] || '', environment)
               when 'probe' then @engine.get_upload(identifier, environment)
               when 'part' then @engine.receive_part(identifier, index, environment['HTTP_UPLOAD_CHECKSUM'] || '', body, environment)
               when 'complete' then @engine.finish_upload(identifier, environment)
               when 'cancel' then @engine.cancel_upload(identifier, environment)
               end
      response(200, result)
    rescue UploadError => error
      response(error.status, { 'code' => error.code, 'message' => error.message })
    rescue JSON::ParserError
      response(400, { 'code' => 'JSON', 'message' => 'Invalid JSON body' })
    rescue StandardError
      response(500, { 'code' => 'INTERNAL', 'message' => 'Upload operation failed' })
    end
    def response(status, value)
      bytes = JSON.generate(value)
      [status, { 'content-type' => 'application/json', 'cache-control' => 'no-store', 'content-length' => bytes.bytesize.to_s }, [bytes]]
    end
  end
end
