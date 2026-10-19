defmodule SalyraUpload.MixProject do
  use Mix.Project

  def project do
    [
      app: :salyra_upload,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: [
        {:jason, "~> 1.4"},
        {:plug, "~> 1.16", optional: true},
        {:bandit, "~> 1.6", only: :dev}
      ],
      description: "Streaming upload sessions with configurable storage",
      package: [
        licenses: ["MIT"],
        links: %{"GitHub" => "https://github.com/salyra-ui/file-upload"}
      ]
    ]
  end

  def application, do: [extra_applications: [:crypto, :logger]]
end
