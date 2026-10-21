# Serviços, origem e limites operacionais

O escopo abrange sete serviços: Mototáxi, Carro, Entrega, Comida, Mercado, Farmácia e Cerveja. `/` gerencia contas, `/app/` reúne os fluxos com registros no servidor e `/demo/` preserva a demonstração histórica separada. O pagamento permanece explicitamente simulado.

## O que havia na fonte recuperada

O frontend original tinha o flag `deliveryFocus=true`: mostrava Comida e Cerveja, esta última indicada como “Em breve”. Os módulos legados preservavam identificadores de mototáxi, carro, entrega, farmácia e documentos. Mercado não existia na fonte recuperada.

A lista original de identificadores incluía `documents` separadamente. No escopo novo, Documentos e Volumes são tipos da opção **Entrega**, não um oitavo serviço.

| Serviço atual | Situação na fonte | Fluxo no servidor | Limite explícito |
| --- | --- | --- | --- |
| Mototáxi (`moto`) | Simulação legada, oculta pelo foco temporário | Cliente solicita corrida; Motorista aceita e registra as etapas | Sem rota, distância ou previsão calculada por provedor externo |
| Carro (`car`) | Simulação legada, oculta pelo foco temporário | Cliente solicita corrida; Motorista aceita e registra as etapas | Sem aprovação de veículo ou CNH |
| Entrega (`delivery`) | Simulação legada; documentos tinham ID próprio | Cliente solicita coleta/entrega; Entregador aceita e registra as etapas; Documentos/Volumes são subtipos | Não há despacho automático de transportadora ou compra externa |
| Comida (`food`) | Fluxo fictício visível, com restaurante de exemplo | Estabelecimento mantém catálogo; Cliente cria pedido; loja registra preparo; Entregador registra retirada e entrega | Catálogo começa vazio; produtos de exemplo não viram lojas reais |
| Mercado (`market`) | Ausente | Novo catálogo por estabelecimento e fluxo de pedido/coleta/entrega | Não existe integração com estoque ou caixa de um supermercado externo |
| Farmácia (`pharmacy`) | Opção legada não operacional | Catálogo do estabelecimento, pedido e etapas logísticas de retirada/entrega | O software não valida receita, não realiza dispensação e não compra em farmácias externas |
| Cerveja (`beer`) | “Em breve” | Catálogo do estabelecimento e fluxo de pedido/coleta/entrega | Sem cobrança, compra automática ou integração comercial externa |

Esta matriz separa os registros operacionais no servidor das integrações externas. Uma opção visual da demonstração não cria uma operação na aplicação principal.

## Dados e preços

Os cadastros reais têm os papéis `client`, `courier`, `establishment` e `driver`. O servidor controla o acesso pelos vínculos persistidos: escolher um papel ou um identificador alheio no navegador não torna a pessoa participante de um pedido.

O catálogo operacional começa vazio. Um estabelecimento cadastra seus próprios produtos; valores de produtos vêm desses registros, e não de um catálogo fictício compartilhado. A aplicação não cadastra automaticamente empresas, produtos ou preços do protótipo.

Corridas, entregas e fretes sem uma política comercial definida devem aparecer como **“a combinar”**. Não há tarifa por quilômetro, distância inventada, comissão automática ou valor de frete presumido. O valor dos produtos de um pedido não deve ser apresentado como um pagamento recebido.

O pagamento é simulado e identificado como tal. Aprovar um teste de pagamento não movimenta saldo, não cobra cartão/Pix e não faz repasse ou saque.

## Catálogo e estabelecimento

Cada conta de Estabelecimento mantém uma loja, em uma das categorias `food`, `market`, `pharmacy` ou `beer`. Uma loja nova começa fechada e não publicada; o proprietário precisa cadastrar os dados, disponibilizar produtos e escolher publicar/abrir. Publicar uma loja não verifica sua identidade comercial, licença, receita ou controle de idade.

O proprietário pode alterar somente sua loja e seus produtos. A listagem pública mostra somente lojas publicadas, sem revelar o identificador do proprietário nem o endereço exato de retirada. O detalhe público mostra apenas produtos disponíveis. O endereço de retirada fica acessível aos participantes autorizados do pedido.

Preços são inteiros em centavos. O servidor aceita até 100 produtos registrados por loja e pedidos com até 50 produtos distintos, de 1 a 99 unidades por item. Para retirar um produto do catálogo, marque-o indisponível: não há exclusão física que apague o histórico. O pedido guarda uma cópia do nome, preço e quantidade usados na criação; edições posteriores do catálogo não reescrevem esse pedido.

| Método e caminho | Acesso e efeito |
| --- | --- |
| `GET /api/stores?category=...` | Consulta pública das lojas publicadas; filtro opcional por categoria |
| `GET /api/stores/:id` | Consulta pública de loja publicada e produtos disponíveis |
| `GET /api/store` | Estabelecimento consulta somente sua própria loja, inclusive rascunho |
| `PUT /api/store` | Estabelecimento cria/edita sua loja, dados de retirada e flags de abertura/publicação |
| `POST /api/store/products` | Estabelecimento adiciona produto à própria loja |
| `PATCH /api/store/products/:id` | Estabelecimento altera nome, descrição, preço ou disponibilidade de seu produto |

## Pedidos e transições

Somente o perfil Cliente cria solicitações. Para categorias de loja, a origem, a categoria, a disponibilidade e os preços vêm do catálogo no banco. O cliente não envia um subtotal confiável nem define o proprietário de uma loja. A criação de pedido, seus itens e o primeiro evento de histórico formam uma transação.

O identificador `requestId` evita duplicação por reenvio: o mesmo cliente e a mesma solicitação repetidos com o mesmo conteúdo devolvem o registro existente; reutilizar esse identificador para outro conteúdo é conflito. Os comandos de aceite e transição exigem a versão atual em `expectedVersion`.

**Mototáxi, Carro e Entrega:**

```text
requested → assigned → heading_to_pickup → picked_up → in_transit → completed
```

**Comida, Mercado, Farmácia e Cerveja:**

```text
Loja: requested → merchant_accepted → preparing → ready
Profissional: ready → assigned → heading_to_pickup → picked_up → in_transit → completed
```

No segundo fluxo, `assigned` ocorre depois de `ready`. O Cliente pode cancelar em `requested`, e o estabelecimento vinculado pode recusar nessa mesma etapa. Não há cancelamento livre após o aceite.

Motoristas aceitam somente Mototáxi/Carro; Entregadores aceitam Entrega e pedidos de lojas prontos. O aceite é exclusivo no servidor, e um profissional não pode manter dois serviços ativos atribuídos ao mesmo tempo. A fila não expõe o endereço exato antes do aceite. O detalhe e o histórico completos exigem vínculo de cliente, profissional atribuído ou proprietário da loja daquele pedido.

| Método e caminho | Efeito |
| --- | --- |
| `GET /api/orders` | Lista até os 100 pedidos mais recentes vinculados à própria conta, sem paginação |
| `POST /api/orders` | Cliente cria solicitação, com identificador de reenvio |
| `GET /api/orders/queue` | Profissional consulta ofertas compatíveis com seu papel |
| `GET /api/orders/:id` | Participante consulta o pedido e seu histórico |
| `POST /api/orders/:id/accept` | Profissional aceita oferta compatível, com `expectedVersion` |
| `POST /api/orders/:id/transition` | Participante executa uma ação permitida no estado e versão atuais |
| `POST /api/orders/:id/delivery-code` | Cliente participante gera um código individual de conclusão durante um serviço ativo |
| `GET /api/orders/:id/location` | Participante consulta a última amostra de localização compartilhada |
| `POST /api/orders/:id/location` | Profissional atribuído compartilha sua amostra durante um serviço ativo |
| `DELETE /api/orders/:id/location` | Profissional atribuído remove a amostra que compartilhou |

A lista de pedidos e a fila de ofertas têm limite de 100 registros por resposta, sem paginação nesta versão. Isso limita a tela consultada; não apaga pedidos antigos do banco. O detalhe de um pedido conhecido continua sujeito à autorização de participante.

### Confirmação de conclusão

O Cliente pode gerar um código individual de seis dígitos durante o serviço ativo. O código é devolvido uma única vez nessa resposta ao Cliente; a API guarda somente seu hash com salt. Não é o código universal da demonstração e não aparece no detalhe consultado pelos outros participantes.

Para passar de `in_transit` a `completed`, o profissional atribuído precisa informar esse código. Ele expira em quinze minutos, tem limite de cinco tentativas inválidas por janela de quinze minutos e é removido depois da conclusão. Gerar outro código invalida o anterior. Isso registra uma confirmação no fluxo, não comprova identidade, pagamento ou a execução física de uma entrega.

## Compartilhamento e atualização

Estados e histórico de operações pertencem ao servidor. Um aceite precisa preservar exclusividade e respeitar o papel e o estado atual do pedido. Recarregar a página não deve criar uma segunda operação nem atribuir um pedido a dois profissionais.

O compartilhamento de GPS usa a localização do navegador somente após uma ação e permissão explícitas. Quando disponível para uma operação, a amostra é acessível apenas aos participantes autorizados pela API. Exibir a última amostra não significa conhecer a posição atual: considerar sempre o horário informado.

O mapa-base usa Leaflet e tiles OpenStreetMap, carregados somente após a ciência do usuário. Um ponto manual não valida nem converte o ponto em endereço. A criação de solicitação aceita pares opcionais de coordenadas de origem/destino; para compras em loja, a origem vem do estabelecimento e o cliente pode informar apenas o ponto de destino. Esses pontos persistidos são marcações declaradas, não endereços verificados ou posições de GPS em tempo real.

A captura de GPS e o envio à API própria são ações distintas. O servidor guarda somente a última amostra do profissional atribuído, e a sinaliza como antiga depois de dois minutos. Não há histórico de trajeto; ao terminar o serviço, a amostra compartilhada é removida pelo servidor.

Parar o compartilhamento, navegar ou sair da conta interrompe a captura na interface e tenta apagar a amostra pela API. O pedido de remoção em `pagehide` é uma tentativa com `keepalive`, não uma garantia: fechar uma aba sem conexão pode impedir esse envio. Nessa situação, a última amostra pode permanecer até sua remoção autorizada ou até o encerramento do serviço, sempre com o horário e a indicação de idade da amostra. A interface não deve apresentá-la como posição atual.

O tile server recebe requisições do navegador, incluindo IP, referência de origem e área visualizada. O GPS bruto não é enviado a um geocodificador. O mapa deve manter a atribuição visível [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright), o `Referer` e o cache HTTP do navegador. O serviço público tem disponibilidade sem garantia; não oferece SLA comercial. Não há download offline, bulk ou prefetch de áreas. Veja a [política oficial de tiles](https://operations.osmfoundation.org/policies/tiles/).

`MAP_TILE_URL` permite configurar um template XYZ HTTPS sem credenciais. O padrão é `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, disponibilizado à interface por `GET /api/map-config`. Não há geocodificação, autocomplete de endereços, roteamento ou estimativa de chegada. Esses recursos continuam dependentes de uma integração própria; nenhum serviço público de demonstração foi usado como substituto.

Trocar o template exige conferir a licença, a atribuição e a política do novo provedor. A atribuição padrão é OpenStreetMap; uma URL arbitrária não implica compatibilidade de licença ou de uso.

Sem a permissão do navegador, com a página fechada ou com falha de conexão, não se deve prometer atualização de localização. GPS no navegador exige contexto seguro, como HTTPS em produção. A arte da scooter da demonstração não representa rastreamento.

Atualizações e notificações dentro da aplicação usam consultas periódicas ao servidor. Elas não são push de sistema, SMS ou e-mail e não comprovam recebimento fora da página aberta.

Cada atualização confere a conta autenticada antes de carregar dados privados. A troca de sessão entre abas limpa perfil, pedidos, loja, carrinho e localização da conta anterior; callbacks atrasados não devem restaurá-los. O canal de sincronização entre abas transmite somente um aviso de mudança, sem nome, e-mail ou token. O servidor identifica a conta das respostas privadas com `X-Titoja-User` e rejeita mutações enviadas pela interface com outra identidade esperada (`409 SESSION_CHANGED`). O cabeçalho não concede acesso: a sessão e as permissões continuam sendo conferidas no banco.

## Roteiro local dos sete serviços

Use e-mails e dados fictícios e escolha suas próprias senhas; o projeto não fornece credenciais padrão. Para conferir papéis simultaneamente, use perfis ou contextos de navegador separados. Abas comuns do mesmo navegador compartilham o cookie da conta. Também é possível sair e entrar sequencialmente: o estado do pedido fica no servidor.

1. Em `/`, cadastre Cliente, Entregador, Motorista e Estabelecimento em contas distintas e abra `/app/` em cada contexto.
2. Como Estabelecimento, crie a loja de uma categoria, informe a retirada, adicione produtos, publique e abra. Uma loja fechada ou não publicada não deve aceitar um novo pedido pelo catálogo.
3. Como Cliente, escolha Comida, Mercado, Farmácia ou Cerveja, selecione uma loja compatível e seus produtos e confirme o destino. Confira o subtotal dos produtos e o frete a combinar; o pagamento continua simulado.
4. Como proprietário vinculado, aceite o pedido, inicie o preparo e marque-o pronto. Antes disso, ele não deve aparecer como oferta pronta para o entregador.
5. Como Entregador, aceite a oferta, registre ida à retirada, retirada e saída para entrega. Como Cliente, gere um código individual e forneça-o ao profissional para a conclusão. Ao concluir, confira o histórico nas contas participantes.
6. Para Mototáxi e Carro, o Cliente informa origem/destino; um Motorista aceita e registra as etapas. Para Entrega, o Cliente pode indicar o tipo, como Mercadoria, Documento ou Volume, e um Entregador executa as etapas. A conclusão também exige o código individual gerado pelo Cliente.
7. Se quiser compartilhar GPS, faça isso por ação explícita e permita o navegador; confira a amostra e o horário na outra conta participante. Parar o compartilhamento deve interromper a captura e tentar remover a amostra; concluir o serviço a remove no servidor. Para testes de mapas externos, use pontos sintéticos, sem dados de localização pessoal.
8. Confira que outra conta sem vínculo não recebe o detalhe privado, que só um profissional aceita a oferta e que o mesmo profissional precisa terminar seu serviço atual antes de aceitar outro.

Repita o fluxo de catálogo para as quatro categorias que desejar validar, usando uma loja compatível em cada teste. Esse roteiro não realiza compra externa, cobrança, verificação de documentos, geocodificação ou prova física de entrega. O build e a suíte completa precisam passar antes de considerar uma versão validada para a próxima etapa de revisão.

## Funções que não devem ser confundidas com operação aprovada

- Recuperação de senha por e-mail continua indisponível; e-mails de conta não são verificados.
- Cadastros de entregador, motorista e estabelecimento não verificam documentos, CNH, veículo, identidade ou vínculo comercial.
- O Admin do frontend histórico é somente uma simulação em `/demo/`. Não concede privilégios na API real.
- Recursos demonstrativos de emergência, carteira, repasse, mensagens e avaliações só podem ser descritos como operacionais quando houver rota, autorização, persistência e testes correspondentes. Uma tela ou um dado local não comprova essa integração.
- O projeto não importa nem exclui os dados reais de D1 ou de serviços anteriores, não altera o Site publicado e não implanta nada na VPS nesta etapa.
