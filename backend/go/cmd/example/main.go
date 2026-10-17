package main

import (
	upload "github.com/salyra-ui/file-upload/backend/go"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	directory := os.Getenv("UPLOAD_DIRECTORY")
	if directory == "" {
		directory = ".uploads"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "4335"
	}
	engine := upload.New(upload.Options{AllowAnonymous: true, Sessions: upload.DiskSessions{Directory: filepath.Join(directory, "sessions")}, Storage: upload.DiskStorage{Directory: filepath.Join(directory, "storage")}})
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	log.Fatal(http.ListenAndServe(host+":"+port, upload.Handler{Engine: engine}))
}
