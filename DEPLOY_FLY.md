# Deploy do Chatwoot no Fly.io

Tudo roda dentro do Fly: app, worker, Postgres, Redis e o storage dos anexos. O único
serviço externo é o SMTP, porque o Fly não envia e-mail. Dois ambientes, no mesmo padrão
do [vox2you-bullmq](https://github.com/vox-2-you/vox2you-bullmq):

| Ambiente | Branch | App | Domínio | Config | Origem do CRM (`FRAME_ANCESTORS`) |
|---|---|---|---|---|---|
| Sandbox | `develop` | `vox2you-chat-sandbox` | `https://sandbox.chat.vox2you.app.br` | `fly.chat.sandbox.toml` | `https://sandbox.vox2you.app.br` |
| Produção | `main` | `vox2you-chat-prod` | `https://chat.vox2you.app.br` | `fly.chat.prod.toml` | `https://vox2you.app.br` |

Recursos por ambiente, sempre com o nome do app como prefixo: `<app>-db` (Managed
Postgres), `<app>-redis` (Redis) e `<app>-files` (Tigris). Região `gru`.

### Recursos (VM)

| Ambiente | web | worker (Sidekiq) | `WEB_CONCURRENCY` | `SIDEKIQ_CONCURRENCY` |
|---|---|---|---|---|
| Sandbox | shared-cpu-1x, 1 GB | shared-cpu-1x, 1 GB | 1 | 5 |
| Produção | shared-cpu-2x, 2 GB | shared-cpu-2x, 2 GB | 2 | 5 |

Uma máquina por process group, sem hibernar (`auto_stop_machines = false`): o ActionCable
mantém websockets abertos. Health check em `GET /health`, que não tem autenticação nem
dependências. `GET /api` serve de smoke test: devolve `queue_services` e `data_services`.

## Por que não dá para usar a Vercel

A Vercel roda funções serverless e arquivos estáticos. O Chatwoot é um monólito Rails que
precisa de runtime Ruby, processo web de longa duração, um worker Sidekiq sempre ligado,
websockets do ActionCable, Postgres com extensões e Redis. A app Next.js continua na Vercel
e o Chatwoot vive aqui.

## Testar local antes de subir

O `docker-compose.local.yaml` sobe a mesma topologia (rails + sidekiq + postgres com
pgvector + redis) usando a imagem oficial, sem build:

```sh
docker compose -f docker-compose.local.yaml up -d postgres redis
docker compose -f docker-compose.local.yaml run --rm rails bundle exec rails db:chatwoot_prepare
docker compose -f docker-compose.local.yaml up -d
```

A app fica em <http://localhost:3001> — porta 3001 porque a 3000 costuma estar ocupada pelo
app Next.js. O primeiro acesso cai em `/installation/onboarding`, onde se cria o super
admin. Para derrubar apagando o banco: `docker compose -f docker-compose.local.yaml down -v`.

Este ambiente usa a imagem publicada, então **não** exercita o ajuste de extensões do
`db/schema.rb` — aqui o Postgres é seu e tem `pg_stat_statements`. O ajuste só importa no
deploy contra o Managed Postgres.

## Peças

| Peça | Como sobe | Observação |
| --- | --- | --- |
| web + worker | `fly deploy --config fly.chat.<env>.toml` | dois process groups, mesma imagem |
| Postgres 16 | `fly mpg create` | gerenciado, com backup; um cluster por ambiente |
| Redis | `fly redis create` | Upstash dentro da rede do Fly; um por ambiente |
| Anexos | `fly storage create` | Tigris, S3-compatível, nativo do Fly |
| SMTP | Elastic Email | único serviço fora do Fly |

## Provisionamento (uma vez por ambiente)

Os comandos abaixo usam o sandbox. Para produção, troque `ENV`, `DOMAIN` e `NEXT_ORIGIN`.

```sh
ENV=sandbox; APP=vox2you-chat-$ENV
DOMAIN=sandbox.chat.vox2you.app.br            # prod: chat.vox2you.app.br
NEXT_ORIGIN=https://sandbox.vox2you.app.br    # prod: https://vox2you.app.br

fly apps create $APP --org vox2you
```

### 1. Postgres

```sh
fly mpg create --name $APP-db --region gru --org vox2you --pg-major-version 16 --plan Basic
```

O comando imprime o **ID do cluster** (algo como `gjpkdonp9n60yln4`); `attach`, `status` e
`connect` usam o ID, não o nome. `fly mpg list -o vox2you` mostra de novo.

O schema do Chatwoot pede quatro extensões. `pg_trgm`, `pgcrypto` e `vector` existem no
Managed Postgres e são ligadas na aba **Extensions** do cluster no dashboard — sem elas a
primeira release falha. A quarta, `pg_stat_statements`, o Fly não oferece (expõe o
`pg_stat_monitor` no lugar). Por isso a linha `enable_extension "pg_stat_statements"` foi
retirada do `db/schema.rb` neste fork; nenhum ponto do código consulta a extensão, ela só
serve para estatística de query. **Se o `db/schema.rb` for atualizado num merge com o
upstream, remova a linha de novo.**

```sh
fly mpg attach <CLUSTER_ID> --app $APP     # grava DATABASE_URL nos secrets do app
```

A `DATABASE_URL` gravada aponta para `pgbouncer.<cluster>.flympg.net`, um pooler em modo
transação. O Rails usa prepared statements e advisory lock nas migrations, e os dois quebram
atrás desse pooler. No passo 4, sobrescreva a variável trocando o host por
`direct.<cluster>.flympg.net:5432`, mantendo usuário, senha e banco (`fly-user`, `fly-db`).
O app usa poucas conexões (5 no web, 5 no Sidekiq) e não precisa do pooler.

Para conferir as extensões: `fly mpg connect <CLUSTER_ID>` e, no `psql`, `\dx`. Se faltar
alguma, `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (idem `pgcrypto`, `vector`); o que for
recusado por permissão só entra pela aba do dashboard.

Um cluster por ambiente: as filas do Sidekiq e as sessões não têm prefixo de ambiente, e
sandbox e produção não podem dividir banco nem Redis.

### 2. Redis

```sh
fly redis create --name $APP-redis --region gru --org vox2you --disable-eviction --no-replicas --plan "Fixed 250MB"
```

- **Plano fixo** (`Fixed 250MB`, US$ 10/mês): o Sidekiq faz polling contínuo, e no plano por
  comando (`Pay-as-you-go`, US$ 0,20 por 100 mil) a conta cresce sem uso. O aviso sobre
  cobrança por comando que o `create` imprime no fim é genérico; confira o plano com
  `fly redis status $APP-redis`.
- **Auto-upgrade: responda Não.** Com Sim, ao bater o limite o Fly sobe sozinho para o plano
  de 1 GB (US$ 20). Só se desliga pelo painel (https://fly.io/dashboard/vox2you/redis).
- **ProdPack: Não** (US$ 200/mês).
- Sem eviction: o Sidekiq guarda a fila no Redis e, com eviction ligada, jobs somem sem
  aviso.

O comando imprime a `REDIS_URL` no final (`fly redis status $APP-redis` mostra de novo);
guarde para o passo 4. É uma variável só: o Chatwoot lê a senha de dentro da URL, e ela só
resolve na rede privada do Fly.

### 3. Storage dos anexos

Volume do Fly não serve: web e worker são máquinas separadas e não compartilham disco. O
Tigris resolve sem sair do Fly:

```sh
fly storage create --name $APP-files --app $APP
```

Ele grava nos secrets do app `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3` (`https://fly.storage.tigris.dev`) e `AWS_REGION` (`auto`), e imprime
os valores **uma única vez** — copie a access key e a secret key na hora; secrets do Fly não
podem ser lidos de volta. Se perder, gere um par novo em
https://fly.io/dashboard/vox2you/tigris → bucket → Access Keys. O Chatwoot lê
outros nomes — o serviço `s3_compatible` em `config/storage.yml` usa `STORAGE_*` —, então
espelhe no passo seguinte. Os `AWS_*` podem ficar; são inofensivos.

### 4. Secrets

Tudo antes do primeiro deploy: `FRONTEND_URL` entra nos links de e-mail e na URL do widget.

```sh
fly secrets set --app $APP \
  DATABASE_URL="postgresql://fly-user:<senha do attach>@direct.<CLUSTER_ID>.flympg.net:5432/fly-db" \
  SECRET_KEY_BASE="$(openssl rand -hex 64)" \
  ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY="$(openssl rand -hex 32)" \
  ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY="$(openssl rand -hex 32)" \
  ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT="$(openssl rand -hex 32)" \
  FRONTEND_URL="https://$DOMAIN" \
  FRAME_ANCESTORS="$NEXT_ORIGIN" \
  REDIS_URL="<url do passo 2>" \
  ACTIVE_STORAGE_SERVICE="s3_compatible" \
  STORAGE_BUCKET_NAME="<BUCKET_NAME do passo 3>" \
  STORAGE_ACCESS_KEY_ID="<AWS_ACCESS_KEY_ID do passo 3>" \
  STORAGE_SECRET_ACCESS_KEY="<AWS_SECRET_ACCESS_KEY do passo 3>" \
  STORAGE_ENDPOINT="<AWS_ENDPOINT_URL_S3 do passo 3>" \
  STORAGE_REGION="auto" \
  STORAGE_FORCE_PATH_STYLE="false" \
  MAILER_SENDER_EMAIL="Vox2You <nao-responda@vox2you.app.br>" \
  SMTP_DOMAIN="vox2you.app.br" \
  SMTP_ADDRESS="smtp.elasticemail.com" \
  SMTP_PORT="2525" \
  SMTP_USERNAME="<e-mail de LOGIN da conta Elastic Email>" \
  SMTP_PASSWORD="<API key do Elastic Email>" \
  SMTP_AUTHENTICATION="login" \
  SMTP_ENABLE_STARTTLS_AUTO="true"
```

Quem grava o quê:

| Secret | Origem |
|---|---|
| `DATABASE_URL` | `fly mpg attach` (passo 1) |
| `BUCKET_NAME`, `AWS_*` | `fly storage create` (passo 3); espelhados em `STORAGE_*` |
| `REDIS_URL` | impressa por `fly redis create` (passo 2) |
| todos os demais | o `fly secrets set` acima |

- Guarde as três chaves `ACTIVE_RECORD_ENCRYPTION_*` em cofre e nunca as regenere: perdê-las
  inutiliza MFA e tokens cifrados. Elas precisam existir **antes** do primeiro usuário —
  ligar depois vira migração de dados.
- No Elastic Email o usuário SMTP é o **e-mail de login da conta**, não o endereço remetente;
  a API key serve como senha. O domínio do remetente precisa estar verificado lá.
- Sem `SMTP_ADDRESS` o mailer cai em `sendmail`, que não existe na imagem: convite de agente
  e reset de senha estouram. Configure o SMTP antes do primeiro convite.
- `FRAME_ANCESTORS` é a origem do CRM que embute o painel (tela `/chat`). Se o CRM de sandbox
  também abrir em previews `*.vercel.app`, acrescente a origem separada por vírgula.
- Não configure `FRONTEND_URL` nem `FRAME_ANCESTORS` no `[env]` do toml: mudam por ambiente
  e o toml é versionado.

### 5. Primeiro deploy

```sh
fly deploy --config fly.chat.$ENV.toml --remote-only --ha=false --build-arg GIT_SHA="$(git rev-parse HEAD)"
```

O que é normal na primeira release: o log mostra `Failed to configure AI Agents SDK:
relation "installation_configs" does not exist` antes de o schema ser carregado; é o boot
rodando antes de existir tabela e some nos deploys seguintes. O build leva ~20 min na
primeira vez (o `bundle install` fica em cache no Depot) e o contexto enviado é de ~170 MB.

`--ha=false` só importa no primeiro deploy: sem ele o Fly cria duas máquinas web e um standby
do worker. Os deploys seguintes mantêm a contagem; se sobrarem máquinas, `fly scale count
web=1 worker=1 --app $APP`.

O `.git` fica fora do contexto de build (são ~400 MB de upload a cada deploy), por isso o
SHA vai por `--build-arg`; sem ele a versão aparece como `unknown` no painel.

O build da imagem é pesado (Ruby + grpc nativo + assets Vite, ~15 min). Se o builder
remoto ficar sem memória, rode com `--build-arg BUNDLE_JOBS=2 --build-arg
GRPC_RUBY_BUILD_PROCS=2`; o recurso seguinte é `fly deploy --depot`. A imagem oficial
(`chatwoot/chatwoot:v4.17.1`) não serve: não contém o `FRAME_ANCESTORS`, o
`sso_redirect_path` nem o ajuste do schema.

A release (`bundle exec rails db:chatwoot_prepare`) carrega o schema e o seed na primeira
subida e roda as migrations nas seguintes; roda numa máquina temporária com os mesmos
secrets e, se falhar, o deploy aborta sem tocar nas máquinas que estão no ar.

### 6. Domínio

```sh
fly ips allocate-v6 --app $APP
fly ips allocate-v4 --shared --app $APP
fly certs add $DOMAIN --app $APP
```

| Ambiente | Tipo | Host | Valor |
|---|---|---|---|
| Sandbox | CNAME | `sandbox.chat` | `vox2you-chat-sandbox.fly.dev` |
| Produção | CNAME | `chat` | `vox2you-chat-prod.fly.dev` |

Com IPv4 compartilhado o Fly pode pedir também um CNAME `_acme-challenge.<host>`; use o
valor que o `certs add` imprimir. Acompanhe com `fly certs check $DOMAIN --app $APP` até o
status `Ready`.

### 7. Super admin

O cadastro público está desligado (`ENABLE_ACCOUNT_SIGNUP=false`). Abrir `https://$DOMAIN`
cai em `/installation/onboarding`, que cria o super admin e a primeira conta. Use o
domínio final, não o `fly.dev`: `FRONTEND_URL` está com o domínio e os links gerados apontam
para ele, então o certificado (passo 6) precisa estar `Ready` antes. Pelo console:

```sh
fly ssh console --app $APP --process-group web --pty -C "bundle exec rails c"
# SuperAdmin.create!(name: 'Admin', email: '...', password: '...', confirmed_at: Time.current)
```

## Integração com o CRM e o worker

Por ambiente, depois do super admin. São oito valores para o CRM e três para o worker.

### No painel do Chatwoot

1. **Platform App** — `/super_admin` → Platform Apps → nova app (nome `Vox2you`). O
   `access_token` mostrado é o `CHATWOOT_PLATFORM_TOKEN`. É com ele que
   `/api/chatwoot/sso` do CRM cria o link de login do atendente. A liberação da conta para a
   app é feita pelo script abaixo.
2. **Token do agente da automação** — precisa ser de um **usuário agente com papel
   Administrador**; token de AgentBot (`/super_admin/agent_bots`) não serve, porque bot não
   acessa `/contacts`. No painel normal (`/app/accounts/1/dashboard`): avatar → Configurações
   de perfil → Token de acesso. No sandbox o do próprio administrador serve; em produção
   crie o agente `automacao@vox2you.app.br` (Configurações → Agentes, papel Administrador),
   entre com ele e copie o token do perfil. É o `CHATWOOT_API_ACCESS_TOKEN`.
3. **Caixa de entrada Website** — Configurações → Caixas de entrada → nova → canal Website,
   domínio do CRM do ambiente. O `websiteToken` do trecho de script é o
   `NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN`.
4. **ID da conta** — o número em `/app/accounts/<id>/...`; normalmente `1`.
5. **Dashboard App** (aba "Aluno" no atendimento) — Configurações → Integrações → Dashboard
   Apps → URL `$NEXT_ORIGIN/chatwoot/student?token=<CHATWOOT_DASHBOARD_TOKEN>`, com o valor
   que já está na Vercel.

### Pelo console (webhook com secret e liberação da Platform App)

O webhook tem secret, mas a tela não tem campo para ele, e a Platform App precisa ser
liberada para a conta (`PlatformAppPermissible`) senão o SSO devolve 401 em `account_users`.
O script abaixo faz os dois de uma vez, sem console interativo; rode no seu terminal com
`APP` e `NEXT_ORIGIN` do ambiente:

```sh
SCRIPT=$(cat <<'RUBY'
acc = Account.find(1)
url = "#{ENV.fetch('NEXT_ORIGIN')}/api/webhooks/chatwoot"
w = Webhook.find_or_initialize_by(account: acc, url: url)
w.subscriptions = %w[message_created message_updated conversation_created]
w.secret = SecureRandom.hex(32) if w.secret.blank?
w.save!
puts "CHATWOOT_WEBHOOK_SECRET=#{w.secret}"
pa = PlatformApp.last
PlatformAppPermissible.find_or_create_by!(platform_app: pa, permissible: acc)
puts "Platform App #{pa.name} liberada para a account #{acc.id}"
RUBY
)
B64=$(printf '%s' "$SCRIPT" | base64 | tr -d '\n')
fly ssh console --app $APP --process-group web \
  -C "sh -c 'echo $B64 | base64 -d | NEXT_ORIGIN=$NEXT_ORIGIN bundle exec rails runner -'"
```

O valor impresso em `CHATWOOT_WEBHOOK_SECRET` vai para o CRM. O webhook aparece depois em
Configurações → Integrações → Webhooks; não crie outro pela tela.

### No CRM (Vercel)

Ambiente que serve o domínio do CRM correspondente (sandbox ou Production):

```env
NEXT_PUBLIC_CHATWOOT_BASE_URL=https://<domínio do Chatwoot>
CHATWOOT_BASE_URL=https://<domínio do Chatwoot>
NEXT_PUBLIC_CHATWOOT_ACCOUNT_ID=1
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_PLATFORM_TOKEN=<passo 1>
CHATWOOT_API_ACCESS_TOKEN=<passo 2>
NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN=<passo 3>
CHATWOOT_WEBHOOK_SECRET=<script acima>
```

Depois de salvar, **redeploy** do CRM: as `NEXT_PUBLIC_*` entram no bundle no build.
`CHATWOOT_DASHBOARD_TOKEN`, `CHATWOOT_DASHBOARD_READER_ID` e `CHATWOOT_DASHBOARD_DEMO` já
existem e não mudam (`DEMO` deve ser `false` em produção).

### No worker

```sh
fly secrets set --app vox2you-worker-<env> \
  CHATWOOT_BASE_URL="https://<domínio do Chatwoot>" \
  CHATWOOT_ACCOUNT_ID="1" \
  CHATWOOT_API_ACCESS_TOKEN="<passo 2>"
```

## Deploy automático (GitHub Actions)

Push na branch dispara deploy no Fly.io:

| Branch | Ambiente | App | Config |
|---|---|---|---|
| `develop` | Sandbox | `vox2you-chat-sandbox` | `fly.chat.sandbox.toml` |
| `main` | Produção | `vox2you-chat-prod` | `fly.chat.prod.toml` |

Workflow: `.github/workflows/deploy.yml`. O `concurrency` por app evita duas releases
rodando migration ao mesmo tempo.

**Secrets no repositório** (`Settings → Secrets and variables → Actions`):

| Secret | Uso |
|---|---|
| `FLY_API_TOKEN` | Token de organização do Fly (`fly tokens create org -x 8760h`); o mesmo do worker serve |

Os apps precisam existir e ter os secrets de runtime configurados antes do primeiro deploy
automático. Opcional: **Environments** `sandbox` e `production` no GitHub para exigir
aprovação manual em produção.

Os workflows do upstream foram removidos deste fork: publicavam no Docker Hub, testavam
deploy na Heroku e rodavam crons de manutenção do projeto original, e todos falhavam ou
faziam ruído a cada push. Num merge com o upstream eles voltam como conflito
modify/delete; resolva com `git rm .github/workflows/<arquivo>`.

## Verificação

1. `curl https://$DOMAIN/health` → `{"status":"woot"}`; `fly checks list --app $APP` verde;
   `fly status --app $APP` com as duas máquinas `started`.
2. `curl https://$DOMAIN/api` → `queue_services` e `data_services` iguais a `"ok"`.
3. `curl -sI http://$DOMAIN/` → redirect para HTTPS; após login o cookie de sessão sai
   `Secure` (`FORCE_SSL`).
4. Login do super admin; `/super_admin` abre.
5. No CRM do ambiente, `/chat` carrega o painel no iframe e o SSO cai na vista pedida. Quadro
   em branco é `FRAME_ANCESTORS` errado (confira o cabeçalho `Content-Security-Policy`).
6. Mensagem numa conversa → `fly logs --app $APP --process-group worker` mostra o Sidekiq
   processando; `/sidekiq` sem fila presa.
7. Anexo numa mensagem → objeto em `fly storage dashboard $APP-files`; a URL do anexo abre.
8. Convite de agente → e-mail chega pelo Elastic Email.
9. Resposta como contato → o CRM recebe `POST /api/webhooks/chatwoot` com assinatura válida.
10. Push em `develop` → job "Sandbox (develop)" verde; `fly releases --app $APP` mostra a versão.

## Merge com o upstream

Depois de `git merge upstream/develop`, confira:

- `db/schema.rb` sem `enable_extension "pg_stat_statements"` (o Managed Postgres recusa).
- `.github/workflows/` só com `deploy.yml`.
- `docker/Dockerfile` ainda com os args `BUNDLE_JOBS` e `GRPC_RUBY_BUILD_PROCS`.
- `config/initializers/frame_ancestors.rb` e o `sso_redirect_path` em
  `app/javascript/v3/views/routes.js` intactos.

## Checklist de produção

Tudo que foi feito no sandbox, com os valores de produção. Na ordem:

| # | Passo | Valor em produção |
|---|---|---|
| 1 | `fly apps create` | `vox2you-chat-prod` |
| 2 | Postgres (`mpg create` + extensões + `attach` + host `direct.`) | `vox2you-chat-prod-db`, plano `Basic` ou maior |
| 3 | Redis (`Fixed 250MB`, auto-upgrade Não) | `vox2you-chat-prod-redis` |
| 4 | Tigris | `vox2you-chat-prod-files` |
| 5 | Secrets (passo 4) | `FRONTEND_URL=https://chat.vox2you.app.br`, `FRAME_ANCESTORS=https://vox2you.app.br`, `MAILER_SENDER_EMAIL` e `SMTP_*` da conta de produção do Elastic Email, chaves novas de `SECRET_KEY_BASE` e `ACTIVE_RECORD_ENCRYPTION_*` guardadas em cofre |
| 6 | Primeiro deploy | `fly deploy --config fly.chat.prod.toml --remote-only --ha=false --build-arg GIT_SHA="$(git rev-parse HEAD)"` |
| 7 | Domínio | `fly certs add chat.vox2you.app.br --app vox2you-chat-prod`; CNAME `chat` → `vox2you-chat-prod.fly.dev` |
| 8 | Super admin | pelo onboarding em `https://chat.vox2you.app.br` |
| 9 | Integração | Platform App, agente `automacao@vox2you.app.br`, inbox Website com domínio `vox2you.app.br`, script do webhook com `NEXT_ORIGIN=https://vox2you.app.br` |
| 10 | CRM | as oito variáveis no ambiente Production da Vercel + redeploy; `CHATWOOT_DASHBOARD_DEMO=false` |
| 11 | Worker | `fly secrets set --app vox2you-worker-prod` com os três `CHATWOOT_*` |
| 12 | Esteira | `git branch main develop && git push -u origin main`; `FLY_API_TOKEN` e environment `production` no GitHub |
| 13 | Verificação | os dez itens da seção acima, no domínio de produção |

Nunca reaproveite de sandbox: `SECRET_KEY_BASE`, chaves de criptografia, Redis, banco,
bucket, tokens do Chatwoot.

## Custo aproximado

| Ambiente | web | worker | Postgres | Redis | Total |
|---|---|---|---|---|---|
| Sandbox | ~US$ 6 | ~US$ 6 | ~US$ 25 | ~US$ 3 | **~US$ 40/mês** |
| Produção | ~US$ 11 | ~US$ 11 | ~US$ 25 | ~US$ 5 | **~US$ 52/mês** |

Tigris é cobrado por uso. Se for preciso cortar, o Managed Postgres do sandbox é o item a
trocar por uma máquina própria com volume (`pgvector/pgvector:pg16`, ~US$ 5), ao custo de
cuidar do backup por conta própria.
