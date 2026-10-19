require 'fileutils'
require 'tempfile'
module SalyraUpload
  module Disk
    def self.safe(identifier)
      raise UploadError.new(400, 'ID', 'Invalid upload identifier') unless identifier.match?(/\A[a-zA-Z0-9_-]{1,100}\z/)
      identifier
    end
    def self.atomic(path, value)
      FileUtils.mkdir_p(File.dirname(path))
      temp = Tempfile.new('.json-', File.dirname(path))
      begin
        temp.write(JSON.generate(value))
        temp.flush
        temp.fsync
        temp.close
        File.rename(temp.path || temp.to_path, path)
      ensure
        temp.close!
      end
    end
    def self.measure(path, index = 0)
      digest, size = Digest::SHA256.new, 0
      File.open(path, 'rb') do |stream|
        while (data = stream.read(65_536))
          digest.update(data)
          size += data.bytesize
        end
      end
      { 'index' => index, 'size' => size, 'sha256' => digest.hexdigest, 'reference' => { 'version' => 1, 'index' => index } }
    end
  end
  class DiskSessions
    def initialize(directory)
      @directory = directory
      FileUtils.mkdir_p(directory)
    end
    def transaction(identifier)
      File.open(File.join(@directory, Disk.safe(identifier) + '.lock'), 'a+b') do |stream|
        stream.flock(File::LOCK_EX)
        begin
          yield
        ensure
          stream.flock(File::LOCK_UN)
        end
      end
    end
    def get(identifier)
      path = File.join(@directory, Disk.safe(identifier) + '.json')
      File.exist?(path) ? JSON.parse(File.read(path)) : nil
    end
    def save(session)
      Disk.atomic(File.join(@directory, Disk.safe(session['id']) + '.json'), session)
      drop_chunk_locks(session) if %w[completed canceled expired].include?(session['state'])
    end

    private

    # Nothing is received for a finished upload any more: its chunk locks can go. A chunk request
    # still streaming is refused at its record.
    def drop_chunk_locks(session)
      descriptor = session['descriptor']
      return unless descriptor['chunkSize'].to_i.positive?
      count = [1, (descriptor['size'] + descriptor['chunkSize'] - 1) / descriptor['chunkSize']].max
      count.times { |index| FileUtils.rm_f(File.join(@directory, SalyraUpload.chunk_lock(session['id'], index) + '.lock')) }
    end
  end
  class DiskStorage
    def initialize(directory)
      @directory = directory
    end
    def parts(session)
      File.join(@directory, 'parts', Disk.safe(session['id']))
    end
    def result(session)
      File.join(@directory, 'files', Disk.safe(session['id']))
    end
    def begin(session, context)
      FileUtils.mkdir_p(parts(session))
      { 'version' => 1, 'id' => session['id'] }
    end
    def write_part(session, part, body, context)
      path = File.join(parts(session), part['index'].to_s)
      if File.exist?(path)
        old = Disk.measure(path, part['index'])
        raise UploadError.new(409, 'PART_CONFLICT', 'Chunk contains different data') if old['size'] != part['size'] || old['sha256'] != part['sha256']
      end
      output = Tempfile.new('.part-', File.dirname(path))
      begin
        digest, size = Digest::SHA256.new, 0
        while (data = body.read(65_536)) && !data.empty?
          size += data.bytesize
          raise UploadError.new(413, 'PART_SIZE', 'Chunk exceeds expected size') if size > part['size']
          digest.update(data)
          output.write(data)
        end
        raise UploadError.new(422, 'CHECKSUM', 'Chunk checksum does not match') if size != part['size'] || digest.hexdigest != part['sha256']
        output.flush
        output.fsync
        output.close
        File.rename(output.path || output.to_path, path)
        saved = part.merge('reference' => { 'version' => 1, 'index' => part['index'] })
        Disk.atomic(path + '.receipt.json', saved)
        saved
      ensure
        output.close!
      end
    end
    def probe(session, context)
      return [] unless Dir.exist?(parts(session))
      Dir.children(parts(session)).filter_map do |name|
        next unless name.match?(/\A\d+\z/)
        path = File.join(parts(session), name)
        receipt = path + '.receipt.json'
        if File.exist?(receipt)
          saved = JSON.parse(File.read(receipt))
        else
          saved = Disk.measure(path, name.to_i)
          Disk.atomic(receipt, saved)
        end
        raise UploadError.new(500, 'STORAGE_CHECKPOINT', 'Stored chunk changed') unless saved['size'] == File.size(path)
        saved
      end.sort_by { |part| part['index'] }
    end
    def inspect_result(session, context)
      return nil unless File.exist?(result(session))
      saved = Disk.measure(result(session))
      raise UploadError.new(500, 'RESULT_SIZE', 'Completed file size does not match') unless saved['size'] == session['descriptor']['size']
      { 'id' => session['id'], 'size' => saved['size'], 'sha256' => saved['sha256'] }
    end
    def finish(session, manifest, context)
      existing = inspect_result(session, context)
      return existing if existing
      path = result(session)
      FileUtils.mkdir_p(File.dirname(path))
      output = Tempfile.new('.result-', File.dirname(path))
      begin
        digest, total = Digest::SHA256.new, 0
        manifest.each do |part|
          part_digest, size = Digest::SHA256.new, 0
          File.open(File.join(parts(session), part['index'].to_s), 'rb') do |input|
            while (data = input.read(65_536))
              digest.update(data)
              part_digest.update(data)
              size += data.bytesize
              output.write(data)
            end
          end
          raise UploadError.new(422, 'CHECKSUM', 'Saved chunk changed') if size != part['size'] || part_digest.hexdigest != part['sha256']
          total += size
        end
        raise UploadError.new(422, 'SIZE', 'Assembled size does not match') if total != session['descriptor']['size']
        output.flush
        output.fsync
        output.close
        File.rename(output.path || output.to_path, path)
        FileUtils.remove_entry(parts(session))
        { 'id' => session['id'], 'size' => total, 'sha256' => digest.hexdigest }
      ensure
        output.close!
      end
    end
    def abort(session, context)
      FileUtils.remove_entry(parts(session)) if Dir.exist?(parts(session))
    end
  end
end
