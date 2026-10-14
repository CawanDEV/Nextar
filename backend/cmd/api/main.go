package main

import (
 "context"
 "log"
	"log/slog"
 "net/http"
 "os"
 "os/signal"
 "syscall"
 "time"

 "github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	slog.Info("starting Nextar API")
 dsn := os.Getenv("DATABASE_URL")
 if dsn == "" { dsn = "postgres://nextar:nextar@localhost:5432/nextar?sslmode=disable" }
 ctx := context.Background()
 db, err := pgxpool.New(ctx, dsn)
 if err != nil { log.Fatal(err) }
 defer db.Close()
	if err = db.Ping(ctx); err != nil { slog.Error("database connection failed", "error", err); log.Fatal(err) }
	if err = migrate(ctx, db); err != nil { slog.Error("database migration failed", "error", err); log.Fatal(err) }
	slog.Info("database ready")
 mux := http.NewServeMux()
 origin := os.Getenv("WEB_ORIGIN")
 if origin == "" { origin = "http://localhost:5173" }
 mux.HandleFunc("/health", func(w http.ResponseWriter,r *http.Request) {
  if err := db.Ping(r.Context()); err != nil { writeJSON(w,503,map[string]string{"status":"unavailable"}); return }
  writeJSON(w,200,map[string]string{"status":"ok","database":"ok"})
 })
 mux.HandleFunc("/api/v1/products", func(w http.ResponseWriter,r *http.Request) {
  if r.Method == http.MethodGet { listProducts(w,r,db); return }
  if r.Method == http.MethodPost { createProduct(w,r,db); return }
  writeJSON(w,405,map[string]string{"error":"method not allowed"})
 })
 mux.HandleFunc("PUT /api/v1/products/{id}", func(w http.ResponseWriter,r *http.Request) {
  updateProduct(w,r,db)
 })
 mux.HandleFunc("DELETE /api/v1/products/{id}", func(w http.ResponseWriter,r *http.Request) {
  deleteProduct(w,r,db)
 })
 mux.HandleFunc("/api/v1/movements", func(w http.ResponseWriter,r *http.Request) {
  if r.Method == http.MethodGet { listMovements(w,r,db); return }
  if r.Method == http.MethodPost { createMovement(w,r,db); return }
  writeJSON(w,405,map[string]string{"error":"method not allowed"})
 })
	mux.HandleFunc("GET /api/v1/logs", func(w http.ResponseWriter,r *http.Request) { listAuditLogs(w,r,db) })
 handler := http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
  w.Header().Set("Access-Control-Allow-Origin",origin)
  w.Header().Set("Access-Control-Allow-Headers","Content-Type")
		w.Header().Set("Access-Control-Allow-Methods","GET, POST, PUT, DELETE, OPTIONS")
  if r.Method == http.MethodOptions { w.WriteHeader(204); return }
		started:=time.Now();status:=&statusWriter{ResponseWriter:w,status:http.StatusOK}
		defer func(){if recovered:=recover();recovered!=nil{slog.Error("request panic recovered","method",r.Method,"path",r.URL.Path,"panic",recovered);http.Error(status,"internal server error",http.StatusInternalServerError)}}()
		mux.ServeHTTP(status,r)
		slog.Info("http request","method",r.Method,"path",r.URL.Path,"status",status.status,"duration_ms",time.Since(started).Milliseconds())
 })
 port:=os.Getenv("PORT"); if port=="" { port="8080" }
 server:=&http.Server{Addr:":"+port,Handler:handler,ReadHeaderTimeout:5*time.Second}
	stop:=make(chan os.Signal,1); signal.Notify(stop,syscall.SIGINT,syscall.SIGTERM)
	go func(){ if err:=server.ListenAndServe(); err!=nil && err!=http.ErrServerClosed { slog.Error("http server stopped unexpectedly","error",err); stopSignal(stop) } }()
	<-stop
	slog.Info("shutting down Nextar API")
	shutdown,cancel:=context.WithTimeout(context.Background(),8*time.Second); defer cancel(); if err:=server.Shutdown(shutdown);err!=nil{slog.Error("graceful shutdown failed","error",err)}
}

type statusWriter struct{http.ResponseWriter;status int}
func(w *statusWriter)WriteHeader(status int){w.status=status;w.ResponseWriter.WriteHeader(status)}
func(w *statusWriter)Write(body []byte)(int,error){return w.ResponseWriter.Write(body)}
func stopSignal(ch chan os.Signal){select{case ch<-syscall.SIGTERM:default:}}

