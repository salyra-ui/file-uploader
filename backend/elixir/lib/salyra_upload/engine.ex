defmodule SalyraUpload.Error do
  defexception [:status, :code, :message]
end

defmodule SalyraUpload.Engine do
  alias SalyraUpload.Error
  defstruct [:sessions, :storage, options: %{}]

  # Without :authorize anyone who reaches the routes can create, read and finish uploads:
  # refused unless allow_anonymous: true (local demos, tests).
  def new(sessions, storage, options \\ %{}) do
    options = Map.new(options)

    unless Map.has_key?(options, :authorize) or options[:allow_anonymous] == true,
      do:
        raise(
          ArgumentError,
          "provide :authorize (and :scope) from your authentication, or allow_anonymous: true for a local demo"
        )

    %__MODULE__{sessions: sessions, storage: storage, options: options}
  end

  defp call({module, configuration}, operation, arguments),
    do: apply(module, operation, [configuration | arguments])

  defp fail(status, code, message), do: raise(Error, status: status, code: code, message: message)
  defp now, do: System.system_time(:millisecond)
  defp count(d), do: max(1, div(d["size"] + d["chunkSize"] - 1, d["chunkSize"]))

  defp authorize(engine, operation, session, context),
    do: Map.get(engine.options, :authorize, fn _, _, _ -> :ok end).(operation, session, context)

  defp notify(engine, type, session, context, part \\ nil) do
    event = %{
      id: session["id"] <> ":" <> type <> if(part, do: ":#{part["index"]}", else: ""),
      type: type,
      session: session,
      part: part
    }

    try do
      Map.get(engine.options, :notify, fn _, _ -> :ok end).(event, context)
    rescue
      error -> Map.get(engine.options, :notification_error, fn _ -> :ok end).(error)
    end
  end

  def create_upload(engine, descriptor, key, context \\ nil) do
    authorize(engine, "create", nil, context)

    integers =
      is_map(descriptor) and
        Enum.all?(["size", "lastModified", "chunkSize"], fn field ->
          is_integer(descriptor[field]) and descriptor[field] >= 0 and
            descriptor[field] <= 9_007_199_254_740_991
        end)

    unless integers and descriptor["protocol"] == "salyra-upload/1" and
             is_binary(descriptor["name"]) and String.length(descriptor["name"]) <= 1024 and
             is_binary(descriptor["type"]) and descriptor["chunkSize"] >= 1 and
             descriptor["chunkSize"] <= Map.get(engine.options, :max_chunk_size, 64 * 1024 * 1024) and
             is_binary(key) and byte_size(key) in 1..200,
           do: fail(400, "DESCRIPTOR", "Invalid upload configuration")

    if descriptor["size"] > Map.get(engine.options, :max_file_size, 9_007_199_254_740_991) or
         count(descriptor) > 100_000, do: fail(413, "FILE_SIZE", "File exceeds its limit")

    Map.get(engine.options, :validate, fn _, _ -> :ok end).(descriptor, context)
    scope = Map.get(engine.options, :scope, fn _ -> "" end).(context)
    id = :crypto.hash(:sha256, Jason.encode!([scope, key])) |> Base.encode16(case: :lower)

    call(engine.sessions, :transaction, [
      id,
      fn ->
        existing = call(engine.sessions, :get, [id])

        if existing do
          authorize(engine, "create", existing, context)

          if existing["descriptor"] != descriptor,
            do: fail(409, "KEY_CONFLICT", "Key belongs to another file")

          existing =
            if existing["expiresAt"] <= now() and existing["state"] == "finalizing",
              do: reconcile(engine, existing, context),
              else: existing

          if existing["expiresAt"] <= now() and existing["state"] != "completed",
            do: fail(410, "EXPIRED", "Session expired")

          %{id: id, chunkSize: descriptor["chunkSize"], expiresAt: existing["expiresAt"]}
        else
          session = %{
            "id" => id,
            "descriptor" => descriptor,
            "expiresAt" => now() + Map.get(engine.options, :ttl_milliseconds, 86_400_000),
            "state" => "open",
            "parts" => []
          }

          session =
            Map.put(session, "storageRef", call(engine.storage, :begin, [session, context]))

          call(engine.sessions, :save, [session])
          notify(engine, "created", session, context)
          %{id: id, chunkSize: descriptor["chunkSize"], expiresAt: session["expiresAt"]}
        end
      end
    ])
  end

  defp get(engine, id, operation, context) do
    session =
      call(engine.sessions, :get, [id]) || fail(404, "NOT_FOUND", "Upload session was not found")

    authorize(engine, operation, session, context)
    if session["state"] == "expired", do: fail(410, "EXPIRED", "Session expired")

    session =
      if session["expiresAt"] <= now() and session["state"] == "finalizing" do
        reconcile(engine, session, context)
      else
        session
      end

    if session["expiresAt"] <= now() and session["state"] not in ["completed", "canceled"] do
      call(engine.storage, :abort, [session, context])
      session = Map.put(session, "state", "expired")
      call(engine.sessions, :save, [session])
      notify(engine, "expired", session, context)
      fail(410, "EXPIRED", "Session expired")
    end

    session
  end

  defp reconcile(engine, session, context) do
    if session["state"] in ["completed", "canceled"] do
      session
    else
      result = call(engine.storage, :inspect_result, [session, context])

      session =
        if result do
          session |> Map.put("state", "completed") |> Map.put("result", result)
        else
          parts = call(engine.storage, :probe, [session, context]) |> Enum.sort_by(& &1["index"])
          d = session["descriptor"]
          indexes = Enum.map(parts, & &1["index"])

          if length(Enum.uniq(indexes)) != length(parts) or
               Enum.any?(parts, fn p ->
                 p["index"] < 0 or p["index"] >= count(d) or
                   p["size"] != min(d["chunkSize"], d["size"] - p["index"] * d["chunkSize"])
               end), do: fail(500, "STORAGE_CHECKPOINT", "Storage returned an invalid part")

          Map.put(session, "parts", parts)
        end

      call(engine.sessions, :save, [session])
      session
    end
  end

  def get_upload(engine, id, context \\ nil) do
    call(engine.sessions, :transaction, [
      id,
      fn ->
        session = reconcile(engine, get(engine, id, "probe", context), context)

        result = %{
          status: session["state"],
          parts: Enum.map(session["parts"], &Map.take(&1, ["index", "size", "sha256"])),
          expiresAt: session["expiresAt"]
        }

        if session["state"] == "completed",
          do: Map.put(result, :result, session["result"]),
          else: result
      end
    ])
  end

  # The lock of one chunk number. Session IDs are hex digests, so a key with a "-part-" suffix is
  # never another session's ID.
  def chunk_lock(id, index), do: id <> "-part-" <> Integer.to_string(index)

  # Holds the session lock only to check and to record. The body streams outside it, under a lock
  # of its own per chunk number taken from the same store, so chunks of one upload arrive side by
  # side and a slow one blocks nobody.
  def receive_part(engine, id, index, checksum, stream, context \\ nil) do
    {session, part, existing} = plan_part(engine, id, index, checksum, context)

    if existing do
      verify_part(existing, part, stream)
    else
      call(engine.sessions, :transaction, [
        chunk_lock(id, index),
        fn ->
          # another request may have stored this chunk number while this one waited
          stored =
            case call(engine.sessions, :get, [id]) do
              nil -> nil
              current -> Enum.find(current["parts"], &(&1["index"] == index))
            end

          if stored do
            verify_part(stored, part, stream)
          else
            saved = call(engine.storage, :write_part, [session, part, stream, context])

            if saved["index"] != part["index"] or saved["size"] != part["size"] or
                 saved["sha256"] != part["sha256"],
               do: fail(500, "STORAGE_RECEIPT", "Storage returned an invalid receipt")

            record_part(engine, id, saved, context)
            Map.take(saved, ["index", "size", "sha256"])
          end
        end
      ])
    end
  end

  # Validates under the session lock. Returns the session, the requested part and the recorded
  # chunk with this number, if there is one.
  defp plan_part(engine, id, index, checksum, context) do
    call(engine.sessions, :transaction, [
      id,
      fn ->
        session = get(engine, id, "part", context)
        if session["state"] != "open", do: fail(409, "STATE", "Upload does not accept chunks")
        d = session["descriptor"]

        unless is_integer(index) and index >= 0 and index < count(d) and is_binary(checksum) and
                 Regex.match?(~r/\A[a-f0-9]{64}\z/, checksum),
               do: fail(400, "PART", "Invalid chunk or checksum")

        part = %{
          "index" => index,
          "size" => min(d["chunkSize"], d["size"] - index * d["chunkSize"]),
          "sha256" => checksum
        }

        {session, part, Enum.find(session["parts"], &(&1["index"] == index))}
      end
    ])
  end

  # A retransmitted body is consumed and checked: a matching header does not prove matching content.
  defp verify_part(existing, part, stream) do
    {digest, size} =
      Enum.reduce(stream, {:crypto.hash_init(:sha256), 0}, fn bytes, {digest, size} ->
        size = size + byte_size(bytes)

        if size > part["size"],
          do: fail(413, "PART_SIZE", "Chunk exceeds expected size")

        {:crypto.hash_update(digest, bytes), size}
      end)

    if size != part["size"] or
         Base.encode16(:crypto.hash_final(digest), case: :lower) != existing["sha256"] or
         part["sha256"] != existing["sha256"],
       do: fail(409, "PART_CONFLICT", "Chunk contains different data")

    Map.take(existing, ["index", "size", "sha256"])
  end

  # The session is read again: it may have been canceled or expired while the body streamed, and
  # other chunks may have been recorded meanwhile.
  defp record_part(engine, id, saved, context) do
    call(engine.sessions, :transaction, [
      id,
      fn ->
        session = get(engine, id, "part", context)
        if session["state"] != "open", do: fail(409, "STATE", "Upload does not accept chunks")

        unless Enum.any?(session["parts"], &(&1["index"] == saved["index"])) do
          # progress keeps a long upload alive: the TTL counts inactivity
          expires =
            max(
              session["expiresAt"],
              now() + Map.get(engine.options, :ttl_milliseconds, 86_400_000)
            )

          session =
            session
            |> Map.put("parts", Enum.sort_by(session["parts"] ++ [saved], & &1["index"]))
            |> Map.put("expiresAt", expires)

          call(engine.sessions, :save, [session])
          notify(engine, "part-stored", session, context, saved)
        end

        :ok
      end
    ])
  end

  def finish_upload(engine, id, context \\ nil) do
    call(engine.sessions, :transaction, [
      id,
      fn ->
        session = reconcile(engine, get(engine, id, "complete", context), context)

        cond do
          session["state"] == "completed" ->
            session["result"]

          session["state"] == "canceled" ->
            fail(409, "CANCELED", "Upload was canceled")

          true ->
            if length(session["parts"]) != count(session["descriptor"]) or
                 Enum.any?(Enum.with_index(session["parts"]), fn {p, index} ->
                   p["index"] != index
                 end), do: fail(409, "INCOMPLETE", "Upload is missing chunks")

            session = Map.put(session, "state", "finalizing")
            call(engine.sessions, :save, [session])

            result =
              try do
                call(engine.storage, :finish, [session, session["parts"], context])
              rescue
                error ->
                  call(engine.storage, :inspect_result, [session, context]) ||
                    reraise(error, __STACKTRACE__)
              end

            session = session |> Map.put("state", "completed") |> Map.put("result", result)
            call(engine.sessions, :save, [session])
            notify(engine, "completed", session, context)
            result
        end
      end
    ])
  end

  def cancel_upload(engine, id, context \\ nil) do
    call(engine.sessions, :transaction, [
      id,
      fn ->
        session = reconcile(engine, get(engine, id, "cancel", context), context)

        if session["state"] == "completed",
          do: fail(409, "COMPLETED", "Remove completed files through the application")

        call(engine.storage, :abort, [session, context])
        session = session |> Map.put("state", "canceled") |> Map.put("parts", [])
        call(engine.sessions, :save, [session])
        notify(engine, "canceled", session, context)
        nil
      end
    ])
  end
end
