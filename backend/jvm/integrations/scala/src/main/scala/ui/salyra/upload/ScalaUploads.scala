package ui.salyra.upload
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.io.InputStream
import scala.concurrent.{ExecutionContext, Future}

/** Configure an ExecutionContext for blocking storage I/O. The application retains stream ownership. */
final class ScalaUploads(engine: UploadEngine)(implicit execution: ExecutionContext) {
  def createUpload(descriptor: ObjectNode, key: String, context: UploadEngine.Context): Future[ObjectNode] = Future(engine.createUpload(descriptor, key, context))
  def getUpload(id: String, context: UploadEngine.Context): Future[ObjectNode] = Future(engine.getUpload(id, context))
  def receivePart(id: String, index: Int, checksum: String, body: InputStream, context: UploadEngine.Context): Future[ObjectNode] = Future(engine.receivePart(id, index, checksum, body, context))
  def finishUpload(id: String, context: UploadEngine.Context): Future[JsonNode] = Future(engine.finishUpload(id, context))
  def cancelUpload(id: String, context: UploadEngine.Context): Future[Unit] = Future(engine.cancelUpload(id, context))
}
