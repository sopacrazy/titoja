# Validação do checkpoint — 21/10/2026

Continuação da migração existente para Node.js/TypeScript e SQLite. A fonte histórica Sites/Cloudflare e os bancos anteriores foram preservados. Nenhuma implantação ou alteração de serviço na VPS foi executada.

## Execução realizada

Ambiente: Windows, Node.js 22.22.0, SQLite incorporado 3.50.4. Dependências instaladas pelo lockfile com `npm ci --prefer-offline --no-audit --no-fund`.

`npm test` executou o build completo e a suíte consolidada: **120 testes aprovados, zero falhas, zero ignorados**.

| Bateria | Aprovados |
| --- | ---: |
| Demonstração legada, incluindo os cinco fluxos DOM | 24 |
| Interface de contas | 16 |
| API de autenticação e segurança | 19 |
| Backup e restauração | 2 |
| Catálogo | 11 |
| Helpers de mapa e GPS | 9 |
| Interface operacional | 25 |
| Pedidos, permissões e concorrência | 13 |
| Integração HTTP dos sete serviços | 1 |
| **Total** | **120** |

Os testes HTTP foram executados com permissão de loopback, pois o sandbox inicial bloqueou as conexões locais com `EACCES`. Todos usam contas sintéticas e bancos temporários; não acessam dados reais ou provedores pagos. O aviso experimental de `node:sqlite` no Node 22 permanece esperado.

O build gerou os módulos de contas/operação/demonstração e `public/vendor` com JavaScript, CSS, imagens e licença Leaflet. `npm run check:public` passou; a revisão manual complementou a busca automática por segredos e artefatos privados. Bancos, logs, dependências, configuração local e artefatos gerados estão excluídos da publicação.

## Evidências funcionais

- Mototáxi, Carro e Entrega percorrem criação, aceite exclusivo, coleta/embarque, trajeto e conclusão com código individual.
- Comida, Mercado, Farmácia e Cerveja incluem catálogo persistente, recebimento e preparo pela loja antes do aceite pelo entregador. Os produtos dos testes são sintéticos; nenhuma compra externa foi feita.
- A integração reinicia servidor e banco durante **cada um dos sete serviços**, em trânsito, e confirma sessão, profissional atribuído, versão, histórico, localização e validade do código emitido antes do reinício. Os pedidos concluídos permanecem disponíveis após novo reinício.
- A disputa de aceite usa também threads e conexões SQLite independentes; apenas um profissional obtém sucesso. Contas sem vínculo não recebem detalhe privado, código ou GPS.
- Troca de conta entre abas limpa os dados anteriores. Respostas tardias e mutações com identidade divergente são rejeitadas. Foco na mesma conta preserva o checkout. Os testes cobrem inclusive troca de conta durante a remoção do GPS antes do logout.
- GPS é solicitado por ação explícita; testes usam coordenadas sintéticas e stubs para permissão negada, falhas e callbacks atrasados. Captura e envios param ao navegar, ocultar a aba, concluir ou sair. Não foi usado GPS pessoal como evidência de rastreamento físico.
- Backup online inclui gravações confirmadas no WAL. A restauração em arquivo separado verifica integridade, chaves estrangeiras e migrations, invalida as sessões copiadas, exige novo login e permite continuar o pedido sem alterar o banco de origem.

## QA no navegador

Interface operacional inspecionada em 1280 × 900 e 390 × 844, sem rolagem horizontal ou imagens quebradas. Criados por formulário uma conta Cliente, uma conta Entregador e uma Entrega de documento com endereços sintéticos; aceite e avanço de etapa apareceram no histórico. Logout e novo cadastro em outra aba atualizaram a identidade da aba operacional sem conservar dados privados anteriores.

Mapa Leaflet carregou somente após o botão de consentimento, com atribuição OpenStreetMap visível e sem erros de console observados. Nenhuma rota ou ETA foi simulada. A demonstração preservada foi inspecionada também em 320 px de largura, sem overflow horizontal.

A imagem de referência foi substituída por um PNG sanitizado, sem nome/localização pessoais. A composição proporcional e as ilustrações usadas como recortes foram verificadas visualmente. Os defaults pessoais da demonstração passaram a Cliente/Cliente Demo. Os arquivos originais permaneceram preservados fora desta cópia.

## Limites para a próxima etapa

Esta validação comprova o fluxo de software local entre sessões próprias. Não comprova prestação física do serviço ou prontidão para produção.

- E-mail não verificado; recuperação de senha e provedor de e-mail ausentes.
- Perfis e estabelecimentos autodeclarados; sem revisão documental, CNH, veículo ou administração operacional.
- Notificações somente na aplicação aberta; sem push, SMS ou e-mail.
- Sem rotas pelas ruas, geocodificação ou ETA. O provedor de tiles e sua atribuição precisam de revisão para o uso externo desejado.
- Listas e filas limitadas a 100 pedidos, sem paginação. O limite de autenticação fica em memória; proteção geral contra abuso e capacidade operacional precisam de revisão.
- Sem suporte administrativo de disputas ou cancelamento após aceite.
- Pagamento, repasse e saque continuam simulados, sem cobrança. Frete e corridas têm valor a combinar.
- Farmácia e bebidas representam catálogo/logística; não há validação de receita/idade ou compra externa automática de produtos regulados.
- Domínio, HTTPS, usuário de serviço, diretórios, porta livre, proxy e política de backup da VPS dependem da etapa de implantação aprovada. Ver [plano isolado](deployment.md).
