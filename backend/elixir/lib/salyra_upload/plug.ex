if Code.ensure_loaded?(Plug.Conn) do
  defmodule SalyraUpload.Plug do
    import Plug.Conn
    alias SalyraUpload.{Engine, Error}
    def init(options), do: options

    # A custom matcher returns {operation, id, index}. The request conn is the application context.
    def call(conn, options) do
      engine = Keyword.fetch!(options, :engine)
      base = Keyword.get(options, :base_path, "/uploads")
      route = if options[:match], do: options[:match].(conn), else: default_route(conn, base)

      try do
        {value, conn} =
          case route do
            {:create, _, _} ->
              # a cross-site form can post text/plain without a CORS preflight, not this type
              media =
                conn
                |> get_req_header("content-type")
                |> List.first("")
                |> String.split(";")
                |> hd()
                |> String.trim()
                |> String.downcase()

              if media != "application/json",
                do:
                  raise(Error,
                    status: 415,
                    code: "CONTENT_TYPE",
                    message: "Upload metadata must be sent as application/json"
                  )

              case read_body(conn, length: 65_536, read_length: 65_536) do
                {:ok, bytes, conn} ->
                  descriptor =
                    case Jason.decode(bytes) do
                      {:ok, descriptor} -> descriptor
                      _ -> raise Error, status: 400, code: "JSON", message: "Invalid JSON body"
                    end

                  {Engine.create_upload(
                     engine,
                     descriptor,
                     header(conn, "idempotency-key"),
                     conn
                   ), conn}

                {:more, _, _} ->
                  raise Error,
                    status: 413,
                    code: "JSON_SIZE",
                    message: "Upload metadata is too large"
              end

            {:probe, id, _} ->
              {Engine.get_upload(engine, id, conn), conn}

            {:part, id, index} ->
              {:ok, agent} = Agent.start_link(fn -> conn end)

              try do
                stream =
                  Stream.resource(
                    fn -> false end,
                    fn done ->
                      if done do
                        {:halt, true}
                      else
                        current = Agent.get(agent, & &1)

                        case read_body(current, length: 65_536, read_length: 65_536) do
                          {:ok, bytes, updated} ->
                            Agent.update(agent, fn _ -> updated end)
                            {[bytes], true}

                          {:more, bytes, updated} ->
                            Agent.update(agent, fn _ -> updated end)
                            {[bytes], false}

                          {:error, reason} ->
                            raise Error, status: 400, code: "BODY", message: inspect(reason)
                        end
                      end
                    end,
                    fn _ -> :ok end
                  )

                value =
                  Engine.receive_part(
                    engine,
                    id,
                    index,
                    header(conn, "upload-checksum"),
                    stream,
                    conn
                  )

                {value, Agent.get(agent, & &1)}
              after
                Agent.stop(agent)
              end

            {:complete, id, _} ->
              {Engine.finish_upload(engine, id, conn), conn}

            {:cancel, id, _} ->
              {Engine.cancel_upload(engine, id, conn), conn}

            _ ->
              raise Error, status: 404, code: "NOT_FOUND", message: "Route was not found"
          end

        conn
        |> put_resp_content_type("application/json")
        |> put_resp_header("cache-control", "no-store")
        |> send_resp(200, Jason.encode!(value))
      rescue
        error in Error ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(error.status, Jason.encode!(%{code: error.code, message: error.message}))

        _ ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(
            500,
            Jason.encode!(%{code: "INTERNAL", message: "Upload operation failed"})
          )
      end
    end

    defp header(conn, name), do: List.first(get_req_header(conn, name)) || ""

    def default_route(conn, base) do
      if conn.request_path == base and conn.method == "POST" do
        {:create, nil, nil}
      else
        if String.starts_with?(conn.request_path, base <> "/") do
          segments =
            String.replace_prefix(conn.request_path, base <> "/", "") |> String.split("/")

          case {conn.method, segments} do
            {"GET", [id]} ->
              {:probe, id, nil}

            {"DELETE", [id]} ->
              {:cancel, id, nil}

            {"POST", [id, "complete"]} ->
              {:complete, id, nil}

            {"PUT", [id, "parts", number]} ->
              case Integer.parse(number) do
                {index, ""} -> {:part, id, index}
                _ -> nil
              end

            _ ->
              nil
          end
        end
      end
    end
  end
end
