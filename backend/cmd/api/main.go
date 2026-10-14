package main

import (
 "context"
 "log"
 "net/http"
 "os"
 "os/signal"
 "syscall"
 "time"

 "github.com/jackc/pgx/v5/pgxpool"
)

func main() {
 dsn := os.Getenv("DATABASE_URL")
 if dsn == "" { dsn = "postgres://nextar:nextar@localhost:5432/nextar?sslmode=disable" }
 ctx := context.Background()
 db, err := pgxpool.New(ctx, dsn)
 if err != nil { log.Fatal(err) }
 defer db.Close()
 if err = db.Ping(ctx); err != nil { log.Fatal(err) }
 if err = migrate(ctx, db); err != nil { log.Fatal(err) }
 mux := http.NewServeMux()
 origin := os.Getenv("WEB_ORIGIN")
 if origin == "" { origin = "http://localhost:5173" }
 mux.HandleFunc("/health", func(w http.ResponseWriter,r *http.Request) {
  if err := db.Ping(r.Context()); err != nil { json(w,503,map[string]string{"status":"unavailable"}); return }
  json(w,200,map[string]string{"status":"ok","database":"ok"})
 })
 mux.HandleFunc("/api/v1/products", func(w http.ResponseWriter,r *http.Request) {
  if r.Method == http.MethodGet { listProducts(w,r,db); return }
  if r.Method == http.MethodPost { createProduct(w,r,db); return }
  json(w,405,map[string]string{"error":"method not allowed"})
 })
 mux.HandleFunc("/api/v1/movements", func(w http.ResponseWriter,r *http.Request) {
  if r.Method == http.MethodGet { listMovements(w,r,db); return }
  if r.Method == http.MethodPost { createMovement(w,r,db); return }
  json(w,405,map[string]string{"error":"method not allowed"})
 })
 handler := http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
  w.Header().Set("Access-Control-Allow-Origin",origin)
  w.Header().Set("Access-Control-Allow-Headers","Content-Type")
  w.Header().Set("Access-Control-Allow-Methods","GET, POST, OPTIONS")
  if r.Method == http.MethodOptions { w.WriteHeader(204); return }
  mux.ServeHTTP(w,r)
 })
 port:=os.Getenv("PORT"); if port=="" { port="8080" }
 server:=&http.Server{Addr:":"+port,Handler:handler,ReadHeaderTimeout:5*time.Second}
 go func(){ if err:=server.ListenAndServe(); err!=nil && err!=http.ErrServerClosed { log.Fatal(err) } }()
 stop:=make(chan os.Signal,1); signal.Notify(stop,syscall.SIGINT,syscall.SIGTERM); <-stop
 shutdown,cancel:=context.WithTimeout(context.Background(),8*time.Second); defer cancel(); _=server.Shutdown(shutdown)
}
