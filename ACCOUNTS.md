# Contas e limites do TitoJá

## Fluxo de cadastro e login

1. Abra a página inicial da aplicação local.
2. Escolha cadastrar, informe nome, e-mail, uma senha de 15 a 128 caracteres e um perfil.
3. Para Estabelecimento, informe também o nome da própria loja.
4. Depois de cadastrar, sua sessão acessa somente seu perfil. Ao sair e entrar novamente, o cadastro permanece no arquivo SQLite configurado.

A raiz `/` é a área de contas. Depois de entrar, **Abrir aplicativo** leva a `/app/`, onde estão os serviços persistidos. `/demo/` é o protótipo separado com dados fictícios.

Os perfis reais são Cliente (`client`), Entregador (`courier`), Motorista (`driver`) e Estabelecimento (`establishment`). Um perfil é fixo nesta versão. Para conferir os quatro fluxos, crie contas de teste distintas com dados fictícios. Não há administrador real, aprovação comercial ou acesso global aos cadastros.

O e-mail é normalizado para identificação de conta e precisa ser único. O servidor não envia e-mail e não verifica que a pessoa controla a caixa postal. Recuperação de senha está indisponível até existir um serviço de e-mail e um fluxo seguro de recuperação. Perfis profissionais e lojas são autodeclarados: cadastro ou publicação não significam aprovação de documentos, CNH, identidade, receita ou atividade comercial. Não use dados sensíveis ou documentos para testar.

## O que persiste

O SQLite local guarda credenciais protegidas por hash, dados básicos da conta, perfil e sessões. Os fluxos operacionais da aplicação principal usam registros de servidor vinculados às contas participantes, separados do estado local do protótipo. Senhas e tokens não são devolvidos pelas respostas da API. A sessão do navegador usa um cookie protegido; não usa `localStorage` para guardar autenticação ou privilégios.

A aplicação principal não recebe dados fictícios de pedidos, produtos ou empresas automaticamente. Cada pessoa vê somente os recursos que a API autoriza para sua conta e seu vínculo com a operação. O pagamento permanece simulado; cadastro não aprova documentos ou habilitação profissional.

Nenhuma conta ou cadastro do banco D1 anterior foi importado. Não é possível entrar automaticamente com uma antiga identidade ChatGPT: este é um cadastro local novo e independente. A adaptação não consulta nem altera o banco ou o Site anteriores.

## Demonstração separada

`/demo/` preserva os módulos TypeScript e os assets da interface anterior. Ela usa dados fictícios no armazenamento do navegador e pode alternar perfis de teste. O Admin dessa área é somente uma simulação local.

Pedidos, itens, acompanhamento visual, preparo de comida, oferta e retirada pelo entregador, carteira, pagamento aprovado, cupons, avaliações, relatórios e exportações **dentro de `/demo/`** pertencem à demonstração. Eles não gravam operações na API principal. A scooter animada não é GPS. O SOS dessa demonstração não chama uma central, documentos não são validados e saque não transfere dinheiro. Rótulos de “Em breve” preservados nessa área descrevem o protótipo, não são prova sobre as rotas da aplicação principal.

Limpar o armazenamento dessa demonstração pode apagar somente seus testes locais. Ela não é fonte de identidade ou autorização da área de contas.

## Garantias implementadas no servidor

- Cadastro restrito aos campos conhecidos; `admin`, identificadores alheios ou permissões no corpo não concedem acesso.
- Senhas protegidas com scrypt, salt aleatório e parâmetros `N=32768`, `r=8`, `p=3`.
- Sessões opacas com hash do token no banco, validade absoluta de sete dias e revogação por logout. O login gera um token novo, e cada usuário pode manter no máximo cinco sessões.
- Cookie `HttpOnly`, `SameSite=Lax` e `Secure` quando configurado para produção HTTPS.
- Identidade consultada a cada requisição privada; autorização pelo papel persistido.
- Mutações protegidas pela origem configurada, limite de corpo e validação de conteúdo.
- SQL parametrizado, e-mail único, chaves estrangeiras e migrations versionadas.
- Cadastro de conta e perfil na mesma transação, sem operações de hash demoradas dentro da transação.
- Respostas privadas sem cache; erros de login sem confirmar qual conta existe.
- Abas compartilham o cookie. A interface confere a identidade no polling e ao voltar ao foco; login e logout sinalizam a mudança às demais abas sem armazenar identidade no navegador. Respostas privadas carregam `X-Titoja-User`, e as ações da interface enviam a identidade esperada: uma conta divergente é rejeitada com `409 SESSION_CHANGED` antes de alterar pedidos, catálogo ou encerrar outra sessão.

O limite padrão de autenticação é de dez tentativas a cada quinze minutos por IP da conexão TCP. Ele fica em memória e é reiniciado com o processo. Por padrão, o servidor ignora `X-Forwarded-For`; atrás de um proxy, os visitantes podem compartilhar esse limite. A opção `TRUST_LOOPBACK_PROXY=true` aceita um único IP válido desse cabeçalho somente quando a conexão vem de loopback. Ela exige um proxy conhecido configurado para sobrescrever o cabeçalho, conforme o [plano de implantação](docs/deployment.md). Essa opção não torna cabeçalhos de identidade ou papéis confiáveis. O limite não substitui configuração de rede, monitoramento e capacidade adequados.

## API de contas

| Método e caminho | Resultado |
| --- | --- |
| `POST /api/auth/register` | Cria conta e perfil permitidos e inicia a sessão |
| `POST /api/auth/login` | Confere e-mail/senha e inicia uma sessão nova |
| `POST /api/auth/logout` | Revoga a sessão apresentada e remove seu cookie |
| `GET /api/account` | Retorna somente o perfil e a identidade da própria sessão |
| `GET /api/dashboard?role=...` | Retorna o próprio perfil se o papel consultado for autorizado |
| `POST /api/auth/password-reset` | Informa indisponibilidade; não envia e-mail nem emite token |

Esses são os endpoints de identidade. As rotas operacionais e seus vínculos de acesso estão descritos em [fluxos de serviço](docs/flows.md). A seleção de perfil no cadastro é limitada aos quatro papéis públicos; não concede acesso aos registros de outras contas.

## Testar

```powershell
npm ci
npm test
```

Os testes usam bancos temporários e contas fictícias. Devem cobrir cadastro dos quatro perfis, login, logout, persistência após reabrir o banco, rejeição de papéis indevidos, isolamento entre usuários, expiração/revogação de sessão e validação de requisições. A interface e a demonstração têm testes de DOM e de domínio próprios; os fluxos operacionais exigem também testes de transições e concorrência.

Não se deve usar um banco real para rodar a suíte. Execute-a no checkout isolado, sem apontar o ambiente de teste para dados de usuários. Passar na suíte não comprova verificação de e-mail, cobrança real, aprovação de documentos, cumprimento físico de uma entrega ou prontidão para produção.
