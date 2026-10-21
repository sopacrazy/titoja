# TitoJá

TitoJá separa contas, operações e o protótipo histórico:

- **`/` - contas:** cadastro, login e logout próprios por e-mail/senha, com perfis de Cliente, Entregador, Motorista ou Estabelecimento.
- **`/app/` - operações:** Mototáxi, Carro, Entrega, Comida, Mercado, Farmácia e Cerveja, com registros compartilhados pelo servidor. O pagamento continua simulado.
- **`/demo/` — demonstração:** a interface original de comida e cerveja, com dados fictícios no navegador. Pedidos, preparo, entregas, pagamentos, carteira e administração dessa área são simulações.

O projeto agora usa uma API Node.js/TypeScript e um arquivo SQLite local. A fonte recuperada usava login ChatGPT/Sites e Cloudflare D1; não havia integração Firebase nesse código. Esta adaptação remove a dependência da hospedagem anterior, não importa nem remove dados do serviço anterior e não altera o Site publicado.

## Executar no computador

Requer **Node.js 22.22.0 ou superior**, com `node:sqlite`, e npm. O módulo SQLite do Node 22 ainda emite um aviso de recurso experimental. Na validação local, Node 22.22.0 incorporava SQLite **3.50.4**. A aplicação exige SQLite incorporado **3.50.4 ou superior** e informa a versão na inicialização; instalar outro `sqlite3` no sistema não atualiza a biblioteca usada pelo Node.

No PowerShell, a partir da pasta do projeto:

```powershell
Copy-Item .env.example .env
npm ci
npm run build
npm test
npm start
```

No Linux/macOS, use `cp .env.example .env` no primeiro passo. Não sobrescreva uma configuração local já existente.

Abra `http://127.0.0.1:4173`. Use esse endereço também no navegador; trocar `127.0.0.1` por `localhost` muda a origem usada para proteger as requisições.

`npm run dev` executa build e inicia o servidor. Não há atualização automática após editar os arquivos: encerre, reconstrua e reinicie o processo.

## Configuração

Os valores de desenvolvimento de `.env.example` são:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=4173
APP_ORIGIN=http://127.0.0.1:4173
BASE_PATH=
DATABASE_PATH=./data/titoja.sqlite
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
TRUST_LOOPBACK_PROXY=false
```

O banco é criado localmente, e as migrations pendentes são aplicadas ao iniciar a aplicação. O histórico usa checksums: não edite migrations já aplicadas. Um histórico de versão incompatível ou modificado impede a inicialização, em vez de reaplicar comandos indiscriminadamente.

O diretório de dados precisa permitir escrita ao usuário que executa o servidor. Em sistemas POSIX, a criação usa diretório `0700`, arquivo novo `0600` e `umask 0077`; permissões de arquivos existentes não são alteradas silenciosamente. No Windows, conferir também as permissões da pasta do usuário. Use um caminho absoluto em uma futura instalação como serviço.

`APP_ORIGIN` deve corresponder à origem externa exata, incluindo esquema e porta quando houver. Em produção, configure uma origem **HTTPS**: o cookie de sessão precisa de `Secure`. O servidor pode continuar em loopback atrás de um proxy HTTPS próprio.

`BASE_PATH` fica vazio para executar na raiz. Para hospedar em uma subpasta, use `BASE_PATH=/titoja` e preserve esse prefixo no proxy: a conta fica em `/titoja/`, operações em `/titoja/app/`, e demonstração em `/titoja/demo/`. `APP_ORIGIN` continua sem caminho, como `https://titoja.example.invalid`. O backend recusa rotas fora da montagem; API, mapa e assets acompanham o prefixo. Não use rewrites que misturem os endpoints desta aplicação com os de outros projetos.

`TRUST_LOOPBACK_PROXY` permanece `false` no uso direto. A ativação é somente para um proxy local conhecido que sobrescreva o cabeçalho de IP do visitante; veja o [plano de implantação](docs/deployment.md). Não afeta a identidade ou o papel dos usuários.

Não são necessários conta padrão, senha inicial ou segredo de integração. Crie cada conta pelo formulário. Não publique `.env`, bancos, backups ou logs.

## Estrutura e comandos

| Caminho/comando | Uso |
| --- | --- |
| `server/` | API TypeScript, autenticação, autorização e servidor de arquivos públicos |
| `migrations/` | Schema SQLite versionado para contas, sessões, lojas, produtos, pedidos e histórico |
| `public/` | Contas, aplicação operacional compilada, estilos e assets preservados |
| `client/` | TypeScript da aplicação operacional e do componente de mapa |
| `frontend/src/` | TypeScript original da demonstração |
| `frontend/static/` | HTML, CSS e assets de origem da demonstração |
| `tests/` | Testes de contas, catálogo, pedidos, interface operacional, mapa e backup |
| `frontend/tests/` | Testes de domínio e fluxos da demonstração |
| `npm run build` | Compila frontend e backend e prepara os arquivos estáticos |
| `npm test` | Reconstrói e executa os testes de API, interface e demonstração, incluindo DOM |
| `npm run db:backup -- <arquivo-novo>` | Cria e verifica um backup consistente; veja [backup e restauração](docs/backup.md) |

Os artefatos de build são gerados localmente. Instale a partir do lockfile com `npm ci`; não é necessário executar os antigos utilitários de hospedagem.

## Contas e segurança

- O cadastro permite somente `client`, `courier`, `driver` ou `establishment`. O papel fica fixo na conta; não existe cadastro de administrador real.
- Senhas têm de **15 a 128 caracteres**. O servidor usa scrypt com salt aleatório (`N=32768`, `r=8`, `p=3`), sem armazenar a senha em texto.
- A sessão usa cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção. O banco guarda o hash do token de sessão, e o logout revoga a sessão no servidor.
- A API obtém a identidade e o papel da sessão e do banco. Campos enviados pelo navegador ou cabeçalhos da antiga hospedagem não concedem privilégios.
- Validação de entrada, consultas parametrizadas, chaves estrangeiras e transações curtas protegem os dados de cadastro. Requisições de escrita exigem a origem configurada.

Veja [contas, testes e limites](ACCOUNTS.md). Os testes automatizados não substituem uma revisão da configuração HTTPS, do proxy e das permissões do servidor antes de uso externo.

## Serviços e limites

Veja [fluxos de serviço, origem e limites](docs/flows.md) para a matriz dos sete serviços, a diferença em relação ao protótipo e as dependências de operação. O catálogo começa vazio: cada estabelecimento precisa cadastrar seus produtos. Sem uma política comercial definida, corridas, entregas e fretes permanecem com valor **a combinar**, sem tarifas ou distâncias inventadas.

O e-mail é um identificador de login **não verificado**. Não há provedor de e-mail nem recuperação de senha operacional. Não existe botão que finja enviar uma recuperação, nem conta administrativa pronta.

Cadastros de entregadores, motoristas e estabelecimentos não validam documentos, CNH, veículo, vínculo comercial ou autorização para operar. Não há cobrança ou repasse financeiro real. O mapa-base OpenStreetMap é opcional, mas não há geocodificação, rota ou previsão de chegada. GPS é uma amostra compartilhada por consentimento com participantes autorizados. Notificações na aplicação não são push, SMS ou e-mail.

Pedidos de Farmácia representam catálogo e logística; o software não verifica receita nem realiza dispensação ou compra externa automática. A demonstração pode trocar perfis fictícios, inclusive Admin; isso não muda a conta autenticada nem acessa dados de outras pessoas.

O banco começa vazio. Nenhum dado real de D1 ou de serviços externos foi exportado, migrado ou excluído. Uma migração de dados reais exigiria planejamento e autorização próprios.

Esta etapa não executa implantação na VPS. O plano futuro está em [implantação isolada](docs/deployment.md).

O [relatório de validação](docs/validation.md) registra o build, os 126 testes executados após o suporte à subpasta, o QA desktop/mobile e os limites deste checkpoint. A validação do software não substitui a preparação e a conferência da instalação externa.

## Origem preservada

A interface e os assets vieram do pacote TypeScript da versão 8 do TitoJá, commit de origem `213cffa0387603ed6ee5025e6222d00042f81bf6`. O ZIP conferido tinha SHA-256 `63df9dce9bf0545511e6ff81a94b3d49125145adf4a6d5848246fb860b005a43`. O histórico Git anterior não foi importado.
