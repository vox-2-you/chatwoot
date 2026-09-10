# Deploy do Chatwoot no Fly.io

Tudo roda dentro do Fly: app, worker, Postgres, Redis e o storage dos anexos.
O único serviço externo é o SMTP, porque o Fly não tem envio de e-mail.

## Testar local antes de subir

O `docker-compose.local.yaml` sobe a mesma topologia (rails + sidekiq + postgres
com pgvector + redis) usando a imagem oficial, sem build:

```sh
docker compose -f docker-compose.local.yaml up -d postgres redis
docker compose -f docker-compose.local.yaml run --rm rails bundle exec rails db:chatwoot_prepare
docker compose -f docker-compose.local.yaml up -d
```

A app fica em <http://localhost:3001> — porta 3001 porque a 3000 costuma estar
ocupada pelo app Next.js. O primeiro acesso cai em `/installation/onboarding`,
onde se cria o super admin. Para derrubar apagando o banco:
`docker compose -f docker-compose.local.yaml down -v`.

Este ambiente usa a imagem publicada, então ele **não** exercita o ajuste de
extensões do `db/schema.rb` — aqui o Postgres é seu e tem `pg_stat_statements`.
O ajuste só importa no deploy contra o Managed Postgres.

## Por que não dá para usar a Vercel

A Vercel roda funções serverless e arquivos estáticos. O Chatwoot é um monólito
Rails que precisa de runtime Ruby, processo web de longa duração, um worker
Sidekiq sempre ligado, websockets do ActionCable, Postgres com extensões e
Redis. Não existe adaptação viável — a app Next.js continua na Vercel e o
Chatwoot vive aqui.

## Peças

| Peça | Como sobe | Observação |
| --- | --- | --- |
| web + worker | `fly deploy` na app `vox2you-chatwoot` | dois process groups, mesma imagem |
| Postgres 16 | `fly mpg create` | gerenciado, com backup e HA; extensões abaixo |
| Redis | `fly redis create` | Upstash rodando dentro da rede do Fly |
| Anexos | `fly storage create` | Tigris, S3-compatível, nativo do Fly |
| SMTP | Resend, SES, Postmark… | único serviço fora do Fly |

## 1. Postgres

```sh
fly mpg create --name vox2you-chatwoot-db --region gru
```

O schema do Chatwoot pede quatro extensões. `pg_trgm`, `pgcrypto` e `vector`
existem no Managed Postgres e são ligadas na aba **Extensions** do cluster no
dashboard. A quarta, `pg_stat_statements`, o Fly não oferece — ele expõe o
`pg_stat_monitor` no lugar. Por isso a linha `enable_extension
"pg_stat_statements"` foi retirada do `db/schema.rb` neste fork; nenhum ponto do
código consulta a extensão, ela só serve para estatística de query. Se o
`db/schema.rb` for atualizado num merge com o upstream, remova a linha de novo.

Pegue a connection string com `fly mpg attach --app vox2you-chatwoot` (ele já
grava `DATABASE_URL` nos secrets) ou `fly mpg status` para montar as variáveis
`POSTGRES_*` manualmente.

## 2. Redis

```sh
fly redis create --name vox2you-chatwoot-redis --region gru
```

Quando o comando perguntar sobre **eviction**, responda que não. O Sidekiq
guarda a fila no Redis e, com eviction ligada, jobs somem sem aviso. O comando
imprime a `REDIS_URL` no final — guarde.

## 3. Storage dos anexos

Volume do Fly não serve: web e worker são máquinas separadas e não compartilham
disco. O Tigris resolve sem sair do Fly e já grava os secrets sozinho:

```sh
fly storage create --name vox2you-chatwoot-files --app vox2you-chatwoot
```

Ele define `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3` e `AWS_REGION`. O Chatwoot espera outros nomes, então
espelhe no passo seguinte.

## 4. App

```sh
fly apps create vox2you-chatwoot

fly secrets set --app vox2you-chatwoot \
  SECRET_KEY_BASE="$(openssl rand -hex 64)" \
  FRONTEND_URL="https://chat.vox2you.com.br" \
  REDIS_URL="<url do passo 2>" \
  ACTIVE_STORAGE_SERVICE="s3_compatible" \
  S3_BUCKET_NAME="vox2you-chatwoot-files" \
  S3_ENDPOINT="https://t3.storage.dev" \
  AWS_REGION="auto" \
  MAILER_SENDER_EMAIL="Vox2You <nao-responda@vox2you.com.br>" \
  SMTP_ADDRESS="..." SMTP_PORT="587" SMTP_USERNAME="..." SMTP_PASSWORD="..."

fly deploy
```

As variáveis de Postgres vêm do `fly mpg attach`. Se preferir os campos
separados em vez de `DATABASE_URL`, defina `POSTGRES_HOST`, `POSTGRES_DATABASE`,
`POSTGRES_USERNAME` e `POSTGRES_PASSWORD` — o `config/database.yml` do Chatwoot
lê os dois formatos.

O build da imagem é pesado (Ruby + assets Vite, ~15 min). Se o builder remoto
ficar sem memória, rode `fly deploy --remote-only --build-arg
NODE_OPTIONS="--max-old-space-size=4096"`. Enquanto o fork não tiver código
próprio além do ajuste no schema, dá para trocar `[build].dockerfile` pela
`image = "chatwoot/chatwoot:v4.17.1"` no `fly.toml` e subir em minutos — mas aí
o ajuste do `pg_stat_statements` não entra na imagem, e o Managed Postgres vai
recusar a carga do schema. Com MPG, construa do Dockerfile.

## 5. Domínio e primeiro acesso

```sh
fly certs add chat.vox2you.com.br --app vox2you-chatwoot
fly ssh console --app vox2you-chatwoot -C "bundle exec rails c"
# no console: User.create!(name: 'Admin', email: '...', password: '...', type: 'SuperAdmin')
```

`FRONTEND_URL` precisa apontar para o domínio final antes do primeiro acesso —
é dele que saem os links de e-mail e a URL do widget.

## Alternativa sem editar o schema

Se preferir não carregar o ajuste no `db/schema.rb`, suba o Postgres como
máquina sua dentro do Fly, com a mesma imagem do `docker-compose.production.yaml`.
Você ganha superusuário e todas as extensões funcionam sem alteração, mas passa
a ser dono do backup e do failover:

```sh
fly apps create vox2you-chatwoot-db
fly volumes create pgdata --app vox2you-chatwoot-db --region gru --size 20
fly machine run pgvector/pgvector:pg16 \
  --app vox2you-chatwoot-db --region gru \
  --volume pgdata:/var/lib/postgresql/data \
  --env POSTGRES_DB=chatwoot_production \
  --env POSTGRES_USER=chatwoot \
  --env POSTGRES_PASSWORD=<senha> \
  --env PGDATA=/var/lib/postgresql/data/pgdata \
  --vm-memory 2048
```

O `fly postgres create` (o Postgres "unmanaged" antigo) também daria
superusuário, mas o Fly o marcou como descontinuado e sem suporte — não vale
começar por ele hoje.

## Custo aproximado

web 2 GB (~US$ 11) + worker 2 GB (~US$ 11) + Managed Postgres no plano básico
(~US$ 25) + Redis (~US$ 5) + Tigris por uso ≈ **US$ 50/mês**. Trocando o MPG
pela máquina própria com volume, cai para uns US$ 40.
