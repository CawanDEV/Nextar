# NEXTAR

Fundação do MVP de controle de estoque: React + TypeScript, API Go e PostgreSQL.

## Executar

Requer Docker e Docker Compose.

    docker compose up --build

- Frontend: http://localhost:5173
- API: http://localhost:8080
- Saúde da API: http://localhost:8080/health
- PostgreSQL: localhost:5432 (nextar/nextar)

## API

- GET /health: verifica API e banco.
- GET /api/v1/products?q=texto&low_stock=true: lista e pesquisa produtos.
- POST /api/v1/products: cadastra produto.
- GET /api/v1/movements: lista movimentações recentes.
- POST /api/v1/movements: registra entrada ou saída; saída sem saldo é recusada.

Produto: {"sku":"CAF-001","name":"Café","unit":"un","quantity":12,"min_quantity":3,"price":19.9}

Movimentação: {"product_id":"UUID","type":"in","quantity":2,"note":"compra"}

As migrações são aplicadas pela API no início. Autenticação e publicação em produção não fazem parte desta base inicial.
