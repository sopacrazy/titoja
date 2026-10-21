import type {OrderStatus, Role} from './types.js';
export type TrackingScene='waiting'|'preparing'|'ready'|'pickup'|'moving'|'delivered'|'cancelled';
export interface TrackingView {stage:number;scene:TrackingScene;icon:string;title:string;description:string;next:string}
export const trackingStages=[{label:'Pedido',icon:'orders'},{label:'Preparo',icon:'clock'},{label:'Pronto',icon:'box'},{label:'Retirada',icon:'bike'},{label:'A caminho',icon:'pin'},{label:'Entregue',icon:'check'}];
const base:Partial<Record<OrderStatus,TrackingView>>={
 pendingAcceptance:{stage:0,scene:'waiting',icon:'clock',title:'Seu pedido chegou à cozinha',description:'Só falta o restaurante confirmar. Você acompanha cada novidade por aqui.',next:'Aceite do restaurante'},
 restaurantAccepted:{stage:1,scene:'preparing',icon:'check',title:'Pedido aceito. Já está na fila!',description:'O restaurante confirmou seu pedido e vai iniciar o preparo.',next:'Início do preparo'},
 preparing:{stage:1,scene:'preparing',icon:'clock',title:'Tem coisa boa sendo preparada',description:'Seu lanche está em preparo. A próxima novidade será quando estiver pronto.',next:'Pedido pronto para retirada'},
 ready:{stage:2,scene:'ready',icon:'box',title:'Tudo pronto por aqui!',description:'Seu pedido está preparado e aguarda um entregador aceitar a retirada.',next:'Entregador aceitar a oferta'},
 assigned:{stage:3,scene:'pickup',icon:'bike',title:'Já temos quem leve seu pedido',description:'O entregador aceitou. Agora ele pode ir buscar seu lanche no restaurante.',next:'Ida ao restaurante'},
 pickingUp:{stage:3,scene:'pickup',icon:'pin',title:'A caminho de buscar seu lanche',description:'O entregador está na etapa de retirada. Você será avisado quando ele pegar o pedido.',next:'Confirmação da retirada'},
 foodCollected:{stage:3,scene:'pickup',icon:'box',title:'Pedido nas mãos do entregador',description:'A retirada foi confirmada. Só falta o entregador iniciar a entrega.',next:'Saída para entrega'},
 outForDelivery:{stage:4,scene:'moving',icon:'bike',title:'Seu lanche está a caminho',description:'A saída para entrega foi confirmada. A próxima etapa é a chegada ao destino.',next:'Confirmação da entrega'},
 completed:{stage:5,scene:'delivered',icon:'check',title:'Chegou! Bom apetite.',description:'Entrega concluída. Seu pedido ficou salvo no histórico. Como foi a experiência?',next:'Sua avaliação'},
 cancelled:{stage:-1,scene:'cancelled',icon:'close',title:'Pedido cancelado',description:'Este pedido foi encerrado na demonstração. Nenhum valor real foi cobrado.',next:'Você pode fazer outro pedido'}
};
const restaurantCopy:Partial<Record<OrderStatus,[string,string,string]>>={
 pendingAcceptance:['Um novo pedido para sua cozinha','Confira os itens e a observação do cliente. O pagamento fictício já foi aprovado.','Aceite para colocar na fila'],
 restaurantAccepted:['Pedido aceito. Vamos preparar?','O cliente já sabe que você confirmou. Inicie o preparo quando começar na cozinha.','Iniciar preparo'],
 preparing:['Capriche no preparo','O cliente acompanha esta etapa. Marque como pronto só quando o pedido estiver preparado.','Liberar para retirada'],
 ready:['Pronto para sair da cozinha','A oferta de retirada já está disponível para o entregador. Aguarde o aceite.','Aguardar entregador'],
 assigned:['Retirada combinada','Um entregador aceitou este pedido. Deixe os itens juntos para a retirada.','Entregador ir ao restaurante'],
 pickingUp:['O entregador está vindo buscar','O pedido está na etapa de retirada. A confirmação será feita pelo entregador.','Confirmar retirada no perfil Entregador'],
 foodCollected:['Pedido retirado com sucesso','O entregador confirmou que pegou o pedido. A cozinha concluiu sua parte.','Saída para entrega'],
 outForDelivery:['Da sua cozinha para o cliente','O pedido saiu para entrega. A conclusão aparecerá aqui quando for confirmada.','Aguardar confirmação da entrega'],
 completed:['Mais um pedido entregue!','O fluxo foi concluído. Itens, valores e horários estão salvos no histórico da cozinha.','Pedido finalizado']
};
const courierCopy:Partial<Record<OrderStatus,[string,string,string]>>={
 ready:['Uma entrega prontinha para você','O restaurante concluiu o preparo. Confira retirada, destino e frete antes de aceitar.','Aceitar a entrega'],
 assigned:['Entrega aceita. Bora buscar?','Seu pedido já está pronto no restaurante. Avance quando iniciar a ida à retirada.','Ir buscar pedido'],
 pickingUp:['Próxima parada: restaurante','Confira o número do pedido ao chegar. Confirme a retirada só quando estiver com os itens.','Confirmar retirada'],
 foodCollected:['Tudo certo com a retirada','Pedido em mãos. Quando estiver pronto para seguir ao destino, inicie a entrega.','Sair para entrega'],
 outForDelivery:['Agora é levar até o cliente','A entrega está em andamento. Confirme a conclusão quando o pedido chegar ao destino.','Confirmar entrega'],
 completed:['Entrega concluída. Mandou bem!','O pedido foi finalizado para todos os perfis. O frete ilustrativo já aparece nos seus ganhos.','Entrega finalizada']
};
export function trackingView(status:OrderStatus,role:Role):TrackingView {
 const view=base[status]||base.pendingAcceptance!;
 const copy=(role==='restaurant'?restaurantCopy:role==='courier'?courierCopy:{})[status];
 return copy?{...view,title:copy[0],description:copy[1],next:copy[2]}:{...view};
}
