package main

import (
 "context"
 "encoding/json"
 "errors"
	"fmt"
 "net/http"
 "log/slog"
	"strings"
 "time"

 "github.com/google/uuid"
 "github.com/jackc/pgx/v5"
 "github.com/jackc/pgx/v5/pgxpool"
)

type Product struct { ID string `json:"id"`; SKU string `json:"sku"`; Name string `json:"name"`; Description string `json:"description"`; Unit string `json:"unit"`; Quantity int `json:"quantity"`; MinQuantity int `json:"min_quantity"`; Price float64 `json:"price"`; CreatedAt time.Time `json:"created_at"` }
type Movement struct { ID string `json:"id"`; ProductID string `json:"product_id"`; ProductName string `json:"product_name,omitempty"`; SKU string `json:"sku,omitempty"`; Type string `json:"type"`; Quantity int `json:"quantity"`; Note string `json:"note"`; CreatedAt time.Time `json:"created_at"` }
type AuditLog struct { ID string `json:"id"`; Action string `json:"action"`; EntityType string `json:"entity_type"`; EntityID string `json:"entity_id"`; Summary string `json:"summary"`; CreatedAt time.Time `json:"created_at"` }
func writeJSON(w http.ResponseWriter,code int,v any){w.Header().Set("Content-Type","application/json");w.WriteHeader(code);_ = encodingJSON(w,v)}
var encodingJSON = func(w http.ResponseWriter,v any) error { return json.NewEncoder(w).Encode(v) }

func listProducts(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool) {
 q:=strings.TrimSpace(r.URL.Query().Get("q")); low:=r.URL.Query().Get("low_stock")=="true"
 rows,err:=db.Query(r.Context(),"SELECT id,sku,name,description,unit,quantity,min_quantity,price,created_at FROM products WHERE ($1='' OR name ILIKE '%'||$1||'%' OR sku ILIKE '%'||$1||'%') AND (NOT $2 OR quantity<=min_quantity) ORDER BY name LIMIT 200",q,low)
 if err!=nil { writeJSON(w,500,map[string]string{"error":"could not list products"});return }; defer rows.Close()
 items:=[]Product{}
 for rows.Next(){ var p Product; if err:=rows.Scan(&p.ID,&p.SKU,&p.Name,&p.Description,&p.Unit,&p.Quantity,&p.MinQuantity,&p.Price,&p.CreatedAt);err!=nil{writeJSON(w,500,map[string]string{"error":"could not read products"});return};items=append(items,p) }
 if rows.Err()!=nil{writeJSON(w,500,map[string]string{"error":"could not read products"});return};writeJSON(w,200,items)
}
func createProduct(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
 var p Product; dec:=json.NewDecoder(http.MaxBytesReader(w,r.Body,1<<20));dec.DisallowUnknownFields()
 if dec.Decode(&p)!=nil{writeJSON(w,400,map[string]string{"error":"invalid JSON"});return}
 p.SKU=strings.TrimSpace(p.SKU);p.Name=strings.TrimSpace(p.Name);p.Unit=strings.TrimSpace(p.Unit)
 if p.SKU==""||p.Name==""||p.Unit==""||p.Quantity<0||p.MinQuantity<0||p.Price<0{writeJSON(w,400,map[string]string{"error":"sku, name and unit are required; numeric values must be non-negative"});return}
	tx,err:=db.Begin(r.Context());if err!=nil{slog.Error("product create transaction failed","error",err);writeJSON(w,500,map[string]string{"error":"could not create product"});return};defer tx.Rollback(context.Background())
	err=tx.QueryRow(r.Context(),"INSERT INTO products(sku,name,description,unit,quantity,min_quantity,price) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at",p.SKU,p.Name,p.Description,p.Unit,p.Quantity,p.MinQuantity,p.Price).Scan(&p.ID,&p.CreatedAt)
	if err!=nil{slog.Error("product create failed","sku",p.SKU,"error",err);writeJSON(w,409,map[string]string{"error":"could not create product; SKU may already exist"});return}
	if err=recordAudit(r.Context(),tx,"product.created","product",p.ID,"Produto cadastrado: "+p.Name);err!=nil{slog.Error("product audit failed","product_id",p.ID,"error",err);writeJSON(w,500,map[string]string{"error":"could not record product change"});return}
	if err=tx.Commit(r.Context());err!=nil{slog.Error("product create commit failed","product_id",p.ID,"error",err);writeJSON(w,500,map[string]string{"error":"could not create product"});return};writeJSON(w,201,p)
}
func updateProduct(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
 id:=r.PathValue("id")
 if _,err:=uuid.Parse(id);err!=nil{writeJSON(w,400,map[string]string{"error":"invalid product id"});return}
 var p Product;dec:=json.NewDecoder(http.MaxBytesReader(w,r.Body,1<<20));dec.DisallowUnknownFields()
 if dec.Decode(&p)!=nil{writeJSON(w,400,map[string]string{"error":"invalid JSON"});return}
 p.SKU=strings.TrimSpace(p.SKU);p.Name=strings.TrimSpace(p.Name);p.Unit=strings.TrimSpace(p.Unit)
 if p.SKU==""||p.Name==""||p.Unit==""||p.Quantity<0||p.MinQuantity<0||p.Price<0{writeJSON(w,400,map[string]string{"error":"sku, name and unit are required; numeric values must be non-negative"});return}
	tx,err:=db.Begin(r.Context());if err!=nil{slog.Error("product update transaction failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not update product"});return};defer tx.Rollback(context.Background())
	err=tx.QueryRow(r.Context(),"UPDATE products SET sku=$1,name=$2,description=$3,unit=$4,min_quantity=$5,price=$6,updated_at=now() WHERE id=$7 RETURNING quantity,created_at",p.SKU,p.Name,p.Description,p.Unit,p.MinQuantity,p.Price,id).Scan(&p.Quantity,&p.CreatedAt)
 if errors.Is(err,pgx.ErrNoRows){writeJSON(w,404,map[string]string{"error":"product not found"});return}
 if err!=nil{writeJSON(w,409,map[string]string{"error":"could not update product; SKU may already exist"});return}
	if err=recordAudit(r.Context(),tx,"product.updated","product",id,"Produto atualizado: "+p.Name);err!=nil{slog.Error("product audit failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not record product change"});return}
	if err=tx.Commit(r.Context());err!=nil{slog.Error("product update commit failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not update product"});return};p.ID=id;writeJSON(w,200,p)
}
func deleteProduct(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
 id:=r.PathValue("id")
 if _,err:=uuid.Parse(id);err!=nil{writeJSON(w,400,map[string]string{"error":"invalid product id"});return}
 var exists,hasMovements bool
 if err:=db.QueryRow(r.Context(),"SELECT EXISTS(SELECT 1 FROM products WHERE id=$1), EXISTS(SELECT 1 FROM movements WHERE product_id=$1)",id).Scan(&exists,&hasMovements);err!=nil{writeJSON(w,500,map[string]string{"error":"could not check product"});return}
 if !exists{writeJSON(w,404,map[string]string{"error":"product not found"});return}
 if hasMovements{writeJSON(w,409,map[string]string{"error":"products with stock history cannot be deleted"});return}
	tx,err:=db.Begin(r.Context());if err!=nil{slog.Error("product delete transaction failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not delete product"});return};defer tx.Rollback(context.Background())
	var name string;if err=tx.QueryRow(r.Context(),"SELECT name FROM products WHERE id=$1 FOR UPDATE",id).Scan(&name);err!=nil{writeJSON(w,404,map[string]string{"error":"product not found"});return}
	if err=recordAudit(r.Context(),tx,"product.deleted","product",id,"Produto excluído: "+name);err!=nil{slog.Error("product audit failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not record product change"});return}
	if _,err=tx.Exec(r.Context(),"DELETE FROM products WHERE id=$1",id);err!=nil{slog.Error("product delete failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not delete product"});return}
	if err=tx.Commit(r.Context());err!=nil{slog.Error("product delete commit failed","product_id",id,"error",err);writeJSON(w,500,map[string]string{"error":"could not delete product"});return}
 w.WriteHeader(http.StatusNoContent)
}
func listMovements(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
 rows,err:=db.Query(r.Context(),"SELECT m.id,m.product_id,p.name,p.sku,m.type,m.quantity,m.note,m.created_at FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 200")
 if err!=nil{writeJSON(w,500,map[string]string{"error":"could not list movements"});return};defer rows.Close()
 items:=[]Movement{};for rows.Next(){var m Movement;if err:=rows.Scan(&m.ID,&m.ProductID,&m.ProductName,&m.SKU,&m.Type,&m.Quantity,&m.Note,&m.CreatedAt);err!=nil{writeJSON(w,500,map[string]string{"error":"could not read movements"});return};items=append(items,m)}
 if rows.Err()!=nil{writeJSON(w,500,map[string]string{"error":"could not read movements"});return};writeJSON(w,200,items)
}
func listAuditLogs(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
	rows,err:=db.Query(r.Context(),"SELECT id,action,entity_type,entity_id,summary,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 200")
	if err!=nil{slog.Error("audit log query failed","error",err);writeJSON(w,500,map[string]string{"error":"could not list audit logs"});return};defer rows.Close()
	items:=[]AuditLog{};for rows.Next(){var item AuditLog;if err=rows.Scan(&item.ID,&item.Action,&item.EntityType,&item.EntityID,&item.Summary,&item.CreatedAt);err!=nil{slog.Error("audit log scan failed","error",err);writeJSON(w,500,map[string]string{"error":"could not read audit logs"});return};items=append(items,item)}
	if err=rows.Err();err!=nil{slog.Error("audit log iteration failed","error",err);writeJSON(w,500,map[string]string{"error":"could not read audit logs"});return};writeJSON(w,200,items)
}
func recordAudit(ctx context.Context,tx pgx.Tx,action,entityType,entityID,summary string)error{
	_,err:=tx.Exec(ctx,"INSERT INTO audit_logs(action,entity_type,entity_id,summary) VALUES($1,$2,$3,$4)",action,entityType,entityID,summary);return err
}
func createMovement(w http.ResponseWriter,r *http.Request,db *pgxpool.Pool){
 var m Movement;dec:=json.NewDecoder(http.MaxBytesReader(w,r.Body,1<<20));dec.DisallowUnknownFields()
 if dec.Decode(&m)!=nil{writeJSON(w,400,map[string]string{"error":"invalid JSON"});return}
 if _,err:=uuid.Parse(m.ProductID);err!=nil||m.Quantity<=0||(m.Type!="in"&&m.Type!="out"){writeJSON(w,400,map[string]string{"error":"invalid product_id, type or quantity"});return}
 tx,err:=db.Begin(r.Context());if err!=nil{writeJSON(w,500,map[string]string{"error":"could not start movement"});return};defer tx.Rollback(context.Background())
	var count int;var productName string;err=tx.QueryRow(r.Context(),"SELECT quantity,name FROM products WHERE id=$1 FOR UPDATE",m.ProductID).Scan(&count,&productName)
 if errors.Is(err,pgx.ErrNoRows){writeJSON(w,404,map[string]string{"error":"product not found"});return};if err!=nil{writeJSON(w,500,map[string]string{"error":"could not load product"});return}
 next:=count+m.Quantity;if m.Type=="out"{next=count-m.Quantity;if next<0{writeJSON(w,409,map[string]string{"error":"insufficient stock"});return}}
 if _,err=tx.Exec(r.Context(),"UPDATE products SET quantity=$1,updated_at=now() WHERE id=$2",next,m.ProductID);err!=nil{writeJSON(w,500,map[string]string{"error":"could not update stock"});return}
	err=tx.QueryRow(r.Context(),"INSERT INTO movements(product_id,type,quantity,note) VALUES($1,$2,$3,$4) RETURNING id,created_at",m.ProductID,m.Type,m.Quantity,m.Note).Scan(&m.ID,&m.CreatedAt)
	if err!=nil{slog.Error("movement insert failed","product_id",m.ProductID,"error",err);writeJSON(w,500,map[string]string{"error":"could not save movement"});return}
	summary:=fmt.Sprintf("Movimentação %s de %s: %d unidade(s)",m.Type,productName,m.Quantity);if note:=strings.TrimSpace(m.Note);note!=""{summary+=" — "+note}
	if err=recordAudit(r.Context(),tx,"movement."+m.Type,"movement",m.ID,summary);err!=nil{slog.Error("movement audit failed","movement_id",m.ID,"error",err);writeJSON(w,500,map[string]string{"error":"could not record movement change"});return}
	if err=tx.Commit(r.Context());err!=nil{slog.Error("movement commit failed","movement_id",m.ID,"error",err);writeJSON(w,500,map[string]string{"error":"could not commit movement"});return};writeJSON(w,201,m)
}

func migrate(ctx context.Context,db *pgxpool.Pool)error{
 _,err:=db.Exec(ctx,"CREATE EXTENSION IF NOT EXISTS pgcrypto");if err!=nil{return err}
 _,err=db.Exec(ctx,"CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'un', quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0), min_quantity INTEGER NOT NULL DEFAULT 0 CHECK(min_quantity>=0), price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(price>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");if err!=nil{return err}
 _,err=db.Exec(ctx,"CREATE TABLE IF NOT EXISTS movements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES products(id), type TEXT NOT NULL CHECK(type IN ('in','out')), quantity INTEGER NOT NULL CHECK(quantity>0), note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())");if err!=nil{return err}
	_,err=db.Exec(ctx,"CREATE INDEX IF NOT EXISTS movements_created_at_idx ON movements(created_at DESC)");if err!=nil{return err}
	_,err=db.Exec(ctx,"CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id UUID NOT NULL, summary TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");if err!=nil{return err}
	_,err=db.Exec(ctx,"CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC)");return err
}

