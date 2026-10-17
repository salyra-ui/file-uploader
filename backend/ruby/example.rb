require 'webrick'
class ChunkReader
  def initialize(request)
    @chunks = Enumerator.new { |yielder| request.body { |chunk| yielder << chunk } }
    @pending, @done = ''.b, false
  end
  def read(length)
    until @pending.bytesize >= length || @done
      begin
        @pending << @chunks.next
      rescue StopIteration
        @done = true
      end
    end
    return nil if @pending.empty? && @done
    value = @pending.byteslice(0, length)
    @pending = @pending.byteslice(value.bytesize..) || ''.b
    value
  end
end
require_relative 'lib/salyra_upload'
directory = ENV.fetch('UPLOAD_DIRECTORY', '.uploads')
engine = SalyraUpload::Engine.new(sessions: SalyraUpload::DiskSessions.new(File.join(directory, 'sessions')), storage: SalyraUpload::DiskStorage.new(File.join(directory, 'storage')), allow_anonymous: true)
app = SalyraUpload::RackApp.new(engine)
server = WEBrick::HTTPServer.new(Port: ENV.fetch('PORT', '4341').to_i, BindAddress: ENV.fetch('HOST', '127.0.0.1'))
handler = Class.new(WEBrick::HTTPServlet::AbstractServlet) do
  define_method(:service) do |request, response|
    environment = { 'REQUEST_METHOD' => request.request_method, 'PATH_INFO' => request.path, 'rack.input' => ChunkReader.new(request) }
    request.header.each { |key, values| environment['HTTP_' + key.upcase.tr('-', '_')] = values.first }
    # Rack keeps these two outside HTTP_*
    environment['CONTENT_TYPE'] = request['Content-Type'] if request['Content-Type']
    environment['CONTENT_LENGTH'] = request['Content-Length'] if request['Content-Length']
    status, headers, body = app.call(environment)
    response.status = status
    headers.each { |key, value| response[key] = value }
    response.body = body.join
  end
end
server.mount('/', handler)
trap('INT') { server.shutdown }
server.start
