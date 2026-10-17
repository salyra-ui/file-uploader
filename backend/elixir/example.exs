directory = System.get_env("UPLOAD_DIRECTORY") || ".uploads"

engine =
  SalyraUpload.Engine.new(
    {SalyraUpload.DiskSessions, Path.join(directory, "sessions")},
    {SalyraUpload.DiskStorage, Path.join(directory, "storage")},
    # a local demo: pass :authorize in an application
    %{allow_anonymous: true}
  )

{:ok, _} =
  Bandit.start_link(
    plug: {SalyraUpload.Plug, engine: engine},
    port: String.to_integer(System.get_env("PORT") || "4342"),
    ip: System.get_env("HOST", "127.0.0.1") |> String.to_charlist() |> :inet.parse_address() |> elem(1)
  )

Process.sleep(:infinity)
