defmodule SalyraUpload.Disk do
  def safe(id) do
    unless is_binary(id) and Regex.match?(~r/\A[a-zA-Z0-9_-]{1,100}\z/, id),
      do: raise(SalyraUpload.Error, status: 400, code: "ID", message: "Invalid upload identifier")

    id
  end

  def atomic(path, value) do
    File.mkdir_p!(Path.dirname(path))
    temp = path <> ".#{System.unique_integer([:positive])}.tmp"

    try do
      {:ok, output} = :file.open(String.to_charlist(temp), [:write, :binary, :raw, :exclusive])

      try do
        :ok = :file.write(output, Jason.encode!(value))
        :ok = :file.sync(output)
      after
        :ok = :file.close(output)
      end

      :ok = File.rename(temp, path)
    after
      File.rm(temp)
    end
  end

  def stream(path) do
    Stream.resource(
      fn ->
        {:ok, file} = :file.open(String.to_charlist(path), [:read, :binary, :raw])
        file
      end,
      fn file ->
        case :file.read(file, 65_536) do
          {:ok, bytes} -> {[bytes], file}
          :eof -> {:halt, file}
          {:error, reason} -> raise File.Error, reason: reason, action: "read", path: path
        end
      end,
      &:file.close/1
    )
  end

  def measure(path, index \\ 0) do
    {digest, size} =
      Enum.reduce(stream(path), {:crypto.hash_init(:sha256), 0}, fn bytes, {digest, size} ->
        {:crypto.hash_update(digest, bytes), size + byte_size(bytes)}
      end)

    %{
      "index" => index,
      "size" => size,
      "sha256" => Base.encode16(:crypto.hash_final(digest), case: :lower),
      "reference" => %{"version" => 1, "index" => index}
    }
  end
end

defmodule SalyraUpload.DiskSessions do
  alias SalyraUpload.Disk
  # Locks coordinate connected BEAM nodes. Independent clusters require a database SessionStore.
  # A bounded number of attempts: a session held too long answers BUSY instead of waiting forever.
  def transaction(directory, id, operation) do
    lock = {{__MODULE__, Path.expand(directory), Disk.safe(id)}, self()}

    case :global.trans(lock, operation, [node() | Node.list()], 30) do
      :aborted ->
        raise SalyraUpload.Error, status: 503, code: "BUSY", message: "Upload session is busy"

      result ->
        result
    end
  end

  def get(directory, id) do
    path = Path.join(directory, Disk.safe(id) <> ".json")
    if File.exists?(path), do: path |> File.read!() |> Jason.decode!(), else: nil
  end

  def save(directory, session),
    do: Disk.atomic(Path.join(directory, Disk.safe(session["id"]) <> ".json"), session)
end

defmodule SalyraUpload.DiskStorage do
  alias SalyraUpload.{Disk, Error}
  defp parts(directory, session), do: Path.join([directory, "parts", Disk.safe(session["id"])])
  defp result(directory, session), do: Path.join([directory, "files", Disk.safe(session["id"])])

  def begin(directory, session, _context) do
    File.mkdir_p!(parts(directory, session))
    %{"version" => 1, "id" => session["id"]}
  end

  def write_part(directory, session, part, stream, _context) do
    path = Path.join(parts(directory, session), Integer.to_string(part["index"]))

    if File.exists?(path) do
      saved = Disk.measure(path, part["index"])

      if saved["size"] != part["size"] or saved["sha256"] != part["sha256"],
        do:
          raise(Error,
            status: 409,
            code: "PART_CONFLICT",
            message: "Chunk contains different data"
          )
    end

    temp = path <> ".#{System.unique_integer([:positive])}.tmp"

    try do
      {:ok, output} = :file.open(String.to_charlist(temp), [:write, :binary, :raw, :exclusive])

      try do
        {digest, size} =
          Enum.reduce(stream, {:crypto.hash_init(:sha256), 0}, fn bytes, {digest, size} ->
            size = size + byte_size(bytes)

            if size > part["size"],
              do:
                raise(Error,
                  status: 413,
                  code: "PART_SIZE",
                  message: "Chunk exceeds expected size"
                )

            :ok = :file.write(output, bytes)
            {:crypto.hash_update(digest, bytes), size}
          end)

        if size != part["size"] or
             Base.encode16(:crypto.hash_final(digest), case: :lower) != part["sha256"],
           do:
             raise(Error, status: 422, code: "CHECKSUM", message: "Chunk checksum does not match")

        :ok = :file.sync(output)
      after
        :ok = :file.close(output)
      end

      :ok = File.rename(temp, path)
      saved = Map.put(part, "reference", %{"version" => 1, "index" => part["index"]})
      Disk.atomic(path <> ".receipt.json", saved)
      saved
    after
      File.rm(temp)
    end
  end

  def probe(directory, session, _context) do
    path = parts(directory, session)

    if File.dir?(path) do
      File.ls!(path)
      |> Enum.filter(&Regex.match?(~r/\A\d+\z/, &1))
      |> Enum.map(fn name ->
        file = Path.join(path, name)
        receipt = file <> ".receipt.json"

        saved =
          if File.exists?(receipt),
            do: receipt |> File.read!() |> Jason.decode!(),
            else: Disk.measure(file, String.to_integer(name))

        if File.stat!(file).size != saved["size"],
          do:
            raise(Error, status: 500, code: "STORAGE_CHECKPOINT", message: "Stored chunk changed")

        if !File.exists?(receipt), do: Disk.atomic(receipt, saved)
        saved
      end)
      |> Enum.sort_by(& &1["index"])
    else
      []
    end
  end

  def inspect_result(directory, session, _context) do
    path = result(directory, session)

    if File.exists?(path) do
      saved = Disk.measure(path)

      if saved["size"] != session["descriptor"]["size"],
        do:
          raise(Error,
            status: 500,
            code: "RESULT_SIZE",
            message: "Completed file size does not match"
          )

      %{"id" => session["id"], "size" => saved["size"], "sha256" => saved["sha256"]}
    end
  end

  def finish(directory, session, manifest, context) do
    existing = inspect_result(directory, session, context)

    if existing do
      existing
    else
      path = result(directory, session)
      File.mkdir_p!(Path.dirname(path))
      temp = path <> ".#{System.unique_integer([:positive])}.tmp"

      try do
        {:ok, output} = :file.open(String.to_charlist(temp), [:write, :binary, :raw, :exclusive])

        {digest, total} =
          try do
            Enum.reduce(manifest, {:crypto.hash_init(:sha256), 0}, fn part, {digest, total} ->
              {digest, part_digest, size} =
                Enum.reduce(
                  Disk.stream(
                    Path.join(parts(directory, session), Integer.to_string(part["index"]))
                  ),
                  {digest, :crypto.hash_init(:sha256), 0},
                  fn bytes, {digest, part_digest, size} ->
                    :ok = :file.write(output, bytes)

                    {:crypto.hash_update(digest, bytes), :crypto.hash_update(part_digest, bytes),
                     size + byte_size(bytes)}
                  end
                )

              if size != part["size"] or
                   Base.encode16(:crypto.hash_final(part_digest), case: :lower) != part["sha256"],
                 do: raise(Error, status: 422, code: "CHECKSUM", message: "Saved chunk changed")

              {digest, total + size}
            end)
            |> then(fn value ->
              :ok = :file.sync(output)
              value
            end)
          after
            :ok = :file.close(output)
          end

        if total != session["descriptor"]["size"],
          do: raise(Error, status: 422, code: "SIZE", message: "Assembled size does not match")

        :ok = File.rename(temp, path)
        {:ok, _} = File.rm_rf(parts(directory, session))

        %{
          "id" => session["id"],
          "size" => total,
          "sha256" => Base.encode16(:crypto.hash_final(digest), case: :lower)
        }
      after
        File.rm(temp)
      end
    end
  end

  def abort(directory, session, _context) do
    case File.rm_rf(parts(directory, session)) do
      {:ok, _} -> :ok
      {:error, reason, path} -> raise File.Error, reason: reason, path: path, action: "remove"
    end
  end
end
