# Nextar — vendedor Telegram e checkout de teste

## Iniciar sem Docker (Windows, macOS ou Linux)

1. Instale **Node.js 24 LTS**. Não é necessário instalar Go, PostgreSQL ou Docker para este modo.
2. Na raiz do repositório execute `npm run setup`. Isso instala e compila o site existente.
3. Copie `.env.example` para `.env`. No Windows: `copy .env.example .env`; macOS/Linux: `cp .env.example .env`.
4. Preencha `TELEGRAM_BOT_TOKEN` no `.env` com o token do BotFather. Nunca o inclua no GitHub.
5. Execute `npm start` e abra **http://localhost:8080**.
6. Cadastre produtos, preços, estoques e descrições na área **Produtos**. Não há produtos inventados ou importação automática.
7. Abra **Vendas e bot** para verificar a conexão e testar a conversa. No Telegram abra seu bot, clique em Iniciar e envie `/catalogo`.

O site, o vendedor e o checkout deste modo usam **o mesmo arquivo SQLite** em `local/data/nextar.sqlite`. A aprovação de teste aparece no site em até cinco segundos, em Vendas e bot, Produtos, Movimentações e Registros. Preserve esse arquivo para manter os dados. Este banco é **separado do PostgreSQL original**: produtos já cadastrados no Docker não são importados, e este módulo não altera o PostgreSQL. Não inicie as duas APIs na porta 8080 ao mesmo tempo.

O modo Docker/Go original continua disponível, mas ainda não executa o módulo de vendas. Esta implementação entrega o fluxo integrado para testes locais. Migrar pedidos e integração Telegram para a infraestrutura de produção exigirá uma etapa posterior.

## Atendimento

- Sem chave de IA: boas-vindas, catálogo, descrição cadastrada, preços, estoque, políticas, carrinho, pedidos, checkout e contato humano através de comandos e frases de compra simples, como `quero 2 CAF-001`.
- Com `OPENAI_API_KEY` e `OPENAI_MODEL`: respostas livres em português, explicações e comparações baseadas no catálogo e nas políticas. A API de IA é um serviço separado; uma assinatura do ChatGPT não configura essa chave. Sem chave válida, o bot informa a indisponibilidade e mantém o fluxo guiado.
- Preencha descrições de produtos com composição, tamanho, compatibilidade e demais fatos que o vendedor deve conhecer. Respostas sem informação cadastrada são encaminhadas ao contato humano, sem inventar garantias, prazos ou descontos.
- Configure `STORE_NAME`, `STORE_POLICIES` e `STORE_CONTACT` para adequar o atendimento. O contato é informado ao cliente; não há transferência automática para uma central humana.
- Ao habilitar IA, perguntas e o catálogo são enviados à API da OpenAI. Cartões reconhecidos no chat são recusados antes dessa etapa.
- O carrinho é persistente e separado por conversa. O histórico recente de perguntas e respostas é persistido; não há análise de áudio ou imagens nesta versão.

## Roteiro de teste

1. Cadastre um produto com SKU `CAF-001`, preço R$ 19,90 e saldo 5.
2. Envie `/catalogo` e faça perguntas sobre o produto.
3. Envie `/comprar CAF-001 2`, depois `/carrinho` e `/finalizar`.
4. Abra o link no **mesmo computador** que executa o servidor. Telegram no celular não consegue abrir o localhost do computador; copie o link para o navegador desse computador. Não exponha este servidor administrativo por túnel público.
5. No checkout digite exclusivamente os dados fictícios exibidos:
   - Titular: `CLIENTE TESTE`
   - Número: `4242424242424242`
   - Validade: `12/30`
   - CVC: `123`
6. Clique em **Aprovar pagamento fictício**. O saldo passa a 3, o pedido recebe o estado `paid_test` e a saída aparece no histórico. Não há cobrança, frete ou entrega reais.
7. No Telegram consulte `/pedidos`. A confirmação de pagamento é mostrada no checkout e nessa consulta; não há notificação proativa nesta versão.
8. Repita o pagamento: não haverá uma segunda baixa. Teste dois compradores disputando a última unidade: somente um concluirá.

O checkout aceita **somente o conjunto sintético acima**; não conecte cartões reais. Número e CVC não são persistidos nem enviados à IA. O endereço do pedido contém um token aleatório que permite acessar somente aquele checkout; não compartilhe o link.

## Regras comerciais

- O pedido expira em 30 minutos. Preço é fotografado ao finalizar; estoque é conferido novamente ao pagar. Não há reserva de estoque.
- Acrescentar/remover itens cancela links de checkout pendentes anteriores. `/cancelar` limpa o carrinho e cancela pedidos pendentes, sem estornar pedidos concluídos.
- A aprovação grava a baixa de todos os itens, as movimentações, o pedido e a auditoria em uma única transação. Falhas desfazem tudo; pagamentos repetidos são idempotentes.
- Não há captura de dinheiro ou registro de venda antes da aprovação explícita do checkout.
- O polling persiste offset, resposta e efeitos comerciais. Reentregar o mesmo update não duplica o carrinho. Falha ao enviar resposta pode repetir mensagens, mas não repete a venda.
- O processo não sobrescreve webhooks existentes. Se houver conflito, o estado exibirá a orientação. Use só uma instância por bot.
- Use `TELEGRAM_ALLOWED_USER_IDS` para limitar testes aos IDs numéricos indicados. Sem essa variável, qualquer usuário que iniciar a conversa privada com o bot poderá testar compras e reduzir o estoque de teste.

## Disponibilidade e segurança local

O processo precisa continuar em execução e ter internet para Telegram e IA. O atendimento só lê mensagens privadas. O site funciona sem internet depois da instalação, e o simulador funciona sem Telegram.

O servidor escuta apenas em `127.0.0.1` e limita hosts/origens para uso local. Não inclui autenticação administrativa ou processamento de pagamentos reais: não publique esta API na internet. O token fica apenas no `.env` ignorado pelo Git. Para substituir um token compartilhado, revogue-o no BotFather e atualize o `.env` local.

## Verificação

`npm test` executa testes de checkout, isolamento de conversas, duplicidade de updates, concorrência de estoque, expiração, cancelamento, rejeição de cartão e API HTTP. `npm run build --prefix frontend` verifica TypeScript e compila o site.
