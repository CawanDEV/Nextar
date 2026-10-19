# NEXTAR

Fundação do MVP de controle de estoque: React + TypeScript, API Go e PostgreSQL.

## Executar com Docker — site e vendedor Telegram

1. Copie `.env.example` para `.env` na raiz e preencha `TELEGRAM_BOT_TOKEN`.
2. Execute `docker compose up --build`.
3. Abra **http://localhost:5173** e entre em **Vendas e bot** para conferir a conexão ou usar o simulador.
4. Cadastre produtos e descrições, abra o bot no Telegram e envie `/start`.

O bot, o checkout e a API Go usam **o mesmo PostgreSQL**, inclusive os produtos já cadastrados. Aprovar o cartão fictício reduz o estoque e grava pedido, movimentação e auditoria na mesma transação. O volume `nextar-data` é preservado; não execute `docker compose down -v` se quiser manter os dados.

- Site: http://localhost:5173 (também servido pelo gateway em http://localhost:8080).
- API e checkout: http://localhost:8080.
- PostgreSQL local: localhost:5432 (nextar/nextar).
- Logs do vendedor: `docker compose logs -f bot`.
- Depois de alterar token/chave no `.env`: `docker compose up -d --force-recreate bot`.

O token não é embutido nas imagens nem no código. Sem token, o site e o simulador funcionam, e a tela informa que o Telegram está desativado. Respostas livres com IA exigem `OPENAI_API_KEY`; sem ela, o atendimento guiado mantém catálogo, carrinho e compra de teste.

Os serviços aguardam banco e API saudáveis antes de iniciar. Portas são publicadas somente em localhost. Links localhost do checkout devem ser abertos no computador que executa o Docker. Não há cobrança nem entrega real; o pagamento é apenas simulado, mas **altera o estoque desse banco**.

## Testes sem Docker

Requer Node.js 24 LTS. Execute `npm run setup`, copie `.env.example` para `.env`, preencha o token e execute `npm start`. Abra http://localhost:8080.

Esse modo continua usando SQLite separado, a menos que `DATABASE_URL` e `API_TARGET` sejam configurados explicitamente. Consulte [o guia completo e o roteiro de teste](local/README.md).

## API

- GET /health: verifica API e banco.
- GET /api/v1/products?q=texto&low_stock=true: lista e pesquisa produtos.
- POST /api/v1/products: cadastra produto.
- PUT /api/v1/products/{id}: edita os dados do produto sem alterar o saldo.
- DELETE /api/v1/products/{id}: exclui apenas produtos sem movimentações.
- GET /api/v1/movements: lista movimentações recentes.
- POST /api/v1/movements: registra entrada ou saída; saída sem saldo é recusada.
- GET /api/v1/logs: lista até 200 alterações de produtos e movimentações.
- GET /api/v1/suppliers: lista fornecedores.
- POST /api/v1/suppliers: cadastra fornecedor.
- PUT /api/v1/suppliers/{id}: atualiza os dados de um fornecedor.
- DELETE /api/v1/suppliers/{id}: exclui fornecedor sem produtos associados.

Produto: {"sku":"CAF-001","name":"Café","unit":"un","quantity":12,"min_quantity":3,"price":19.9}

Movimentação: {"product_id":"UUID","type":"in","quantity":2,"note":"compra"}

Fornecedor: {"name":"Distribuidora Central","contact_name":"Pessoa responsável","email":"contato@exemplo.com","phone":"(11) 0000-0000"}

As migrações são aplicadas pela API no início. Os logs técnicos em JSON são enviados para a saída padrão da API (visíveis com `docker compose logs -f api`); o histórico de alterações fica persistido no PostgreSQL e aparece na tela **Registros**. As gravações de negócio e seus registros de auditoria são feitas na mesma transação.

Autenticação e publicação em produção não fazem parte desta base inicial. Logs ajudam a diagnosticar falhas, mas não substituem monitoramento, backups nem uma política de recuperação.

