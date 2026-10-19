package ui.salyra.upload
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/** The application chooses its executor and request context. The stream stays open until its future completes. */
class KotlinUploads(private val engine: UploadEngine, private val executor: Executor) {
    private fun <T> execute(operation: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync(operation, executor)
    fun createUpload(descriptor: ObjectNode, key: String, context: UploadEngine.Context) = execute { engine.createUpload(descriptor, key, context) }
    fun getUpload(id: String, context: UploadEngine.Context) = execute { engine.getUpload(id, context) }
    fun receivePart(id: String, index: Int, checksum: String, stream: InputStream, context: UploadEngine.Context) = execute { engine.receivePart(id, index, checksum, stream, context) }
    fun finishUpload(id: String, context: UploadEngine.Context): CompletableFuture<JsonNode> = execute { engine.finishUpload(id, context) }
    fun cancelUpload(id: String, context: UploadEngine.Context): CompletableFuture<Void> = CompletableFuture.runAsync({ engine.cancelUpload(id, context) }, executor)
}

/** To cancel I/O, set context.canceled() when your framework reports request cancellation. */
suspend fun <T> CompletableFuture<T>.awaitUpload(): T = suspendCoroutine { continuation ->
    whenComplete { result, error ->
        if (error != null) continuation.resumeWithException(error.cause ?: error)
        else continuation.resume(result)
    }
}
