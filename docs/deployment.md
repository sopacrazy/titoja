# Plano de implantação isolada futura

Este documento descreve uma etapa futura. A adaptação do repositório **não instala, reinicia, reconfigura ou implanta nada na VPS**. A implantação precisa de revisão própria da configuração e dos projetos que já estão ativos.

## Isolamento necessário

- Usar um usuário de serviço exclusivo, sem executar a aplicação como root.
- Manter checkout, arquivo SQLite e backups em caminhos próprios do TitoJá. Não reutilizar diretórios de outro projeto.
- Expor o processo Node somente em loopback. O acesso externo deve passar por uma configuração HTTPS exclusiva e revisada no proxy.
- Restringir as permissões do diretório de dados e dos backups ao usuário de serviço e à administração autorizada. O banco contém e-mails e hashes de credenciais; não deve ficar sob uma raiz pública.
- Fazer um backup consistente antes de qualquer mudança de schema ou atualização. Veja [backup e restauração](backup.md).

A VPS já hospeda outros projetos. Antes de escolher uma porta, conferir os serviços e listeners ativos e registrar o inventário em documentação privada da instalação. Não parar serviços nem reaproveitar portas ocupadas para resolver um conflito.

## Preparação de um release

Em uma pasta de release separada, com Node **22.22.0 ou superior**:

```sh
npm ci
npm run build
npm test
```

Conferir a versão SQLite incorporada ao Node, as migrations e os resultados dos testes. A aplicação exige SQLite incorporado `>=3.50.4`; o `sqlite3` do sistema não é a biblioteca usada por `node:sqlite`. A inicialização informa a versão incorporada. Manter uma versão Node compatível e atualizada, com o lockfile e os testes conferidos no release.

Criar a configuração fora do controle de versão. Exemplo sem credenciais:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
APP_ORIGIN=https://titoja.example.invalid
DATABASE_PATH=/srv/titoja/data/titoja.sqlite
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
TRUST_LOOPBACK_PROXY=false
```

O domínio é um placeholder, e a porta só pode ser adotada depois de confirmar que está livre. A origem deve ser substituída pela origem HTTPS aprovada. Não desativar `Secure` para contornar problemas de proxy ou TLS.

O banco novo começa vazio, e as migrations são aplicadas na inicialização. Essa ação cria/atualiza somente o arquivo SQLite configurado; não é um procedimento de importação de D1 ou Firebase. Não apontar o processo para arquivos de outro projeto.

## Serviço e proxy

Uma futura unidade systemd deve usar usuário próprio, `WorkingDirectory` no release, arquivo de configuração protegido, `NODE_ENV=production`, caminho absoluto do banco e o Node aprovado. O processo deve receber encerramento gracioso antes de trocar um release ou restaurar o banco.

Revisar a unidade e a política de reinício antes de ativá-la. Criar uma configuração nginx específica para o domínio/rota aprovada; validar a configuração completa antes de aplicar qualquer mudança. Não substituir a configuração global nem editar blocos de sites existentes durante uma instalação do TitoJá.

O proxy deve preservar a origem/host externos esperados. Não confiar em cabeçalhos de identidade ou papéis enviados pelo visitante. As proteções de origem da API não substituem HTTPS nem autorização no servidor.

O limite de autenticação usa o IP da conexão TCP. Por padrão, `TRUST_LOOPBACK_PROXY=false` ignora `X-Forwarded-For`; atrás de um proxy, visitantes podem compartilhar o IP e o limite. Habilitar a opção somente após conferir que o proxy local conhecido sobrescreve o cabeçalho com o IP de sua conexão externa:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

Não usar `$proxy_add_x_forwarded_for` nesse contrato: a API aceita somente um IP válido, sem cadeia, e apenas se o socket de origem for loopback. Cabeçalhos inválidos usam o IP do socket como fallback. Isso ajusta o limite de tentativas, não autentica pessoas nem concede papéis. Revisar a proteção de abuso no proxy e o modelo de confiança antes de liberar acesso externo; não habilitar confiança irrestrita em cabeçalhos para contornar o limite.

## Verificações antes de liberar acesso

1. Confirmar isolamento de diretórios, porta e usuário de serviço.
2. Conferir HTTPS, cookie `Secure`/`HttpOnly`, origem configurada e ausência de acesso direto ao banco.
3. Testar contas fictícias de Cliente, Entregador, Motorista e Estabelecimento, incluindo rejeição de acesso cruzado, logout e os sete fluxos de serviço. Conferir exclusividade de aceite e transições pelo servidor.
4. Confirmar que `/demo/` continua claramente identificada como simulação e não dá acesso administrativo real.
5. Criar um backup e testar sua restauração em um arquivo temporário separado.
6. Conferir que logs não registram senhas, cookies, tokens ou corpos de cadastro/login.
7. Manter a versão anterior e um plano de reversão da aplicação e do schema. Trocar apenas o código sem considerar migrations não é um rollback de banco.

Não há nesta versão provedor de e-mail, recuperação de senha ou verificação de endereço de e-mail. Pagamento e repasse financeiro continuam simulados. Aprovação de documentos/CNH/empresas, dispensação farmacêutica, geocodificação, rotas e previsão de chegada não estão implementados. O mapa-base usa tiles externos mediante ciência do usuário; conferir a política e a disponibilidade do provedor configurado antes de uma operação externa. Notificações na página não são push de sistema. Uma instalação externa não supre essas dependências automaticamente.
