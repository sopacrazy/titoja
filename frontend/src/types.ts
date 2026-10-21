export type Role = 'client' | 'driver' | 'courier' | 'restaurant' | 'admin';
export type ProfessionalRole = 'driver' | 'courier';
export type ServiceId = 'moto' | 'car' | 'delivery' | 'food' | 'beer' | 'pharmacy' | 'documents';
export type OrderStatus = 'searching' | 'accepted' | 'arrived' | 'boarded' | 'collected' | 'ongoing' | 'completed' | 'cancelled' | 'pendingAcceptance' | 'restaurantAccepted' | 'preparing' | 'ready' | 'assigned' | 'pickingUp' | 'foodCollected' | 'outForDelivery';
export type OrderKind = 'ride' | 'delivery';
export interface Service { id:ServiceId; name:string; desc?:string; icon?:string; crop:[number,number,number,number] }
export interface Professional { id:string; name:string; initials:string; rating:string; vehicle:string; car?:string; plate:string; jobs:number }
export interface OrderInput {service:ServiceId;from:string;to:string;deliveryType?:string;note?:string;payment?:string}
export interface Quote { distance:number; minutes:number; price:number }
export interface Order extends OrderInput, Quote { food?:FoodDetails; id:string;kind:OrderKind;status:OrderStatus;created:string;finished?:string;professional?:ProfessionalRole;rejectedBy?:ProfessionalRole[];rating?:number;tags?:string[] }
export interface Notification {id:string;text:string;read:boolean}
export interface Transaction {id:string;label:string;amount:number;date:string}
export interface Application {id:string;name:string;type:string;vehicle:string;status:'pending'|'approved'|'rejected'}
export interface DemoState {foodCart:CartLine[];demoProfiles:Record<FoodRole,DemoProfile>;version:1;loggedIn:boolean;name:string;role:Role;online:Record<ProfessionalRole,boolean>;balance:number;notifications:Notification[];orders:Order[];transactions:Transaction[];addresses:{label:string;address:string}[];applications:Application[];coupons:{id:string;discount:string;active:boolean}[];complaints:{id:string;title:string;name:string;status:'open'|'resolved'}[];settings:{notifications:boolean;darkMap:boolean};paymentsReviewed:boolean}

export type FoodRole = 'client' | 'restaurant' | 'courier';
export interface DemoProfile {name:string;registered:boolean;registeredAt?:string}
export interface CartLine {productId:string;quantity:number}
export interface MenuProduct {id:string;name:string;description:string;price:number;category:string;visual:string}
export interface FoodItem {productId:string;name:string;unitPrice:number;quantity:number;lineTotal:number}
export interface FoodEvent {status:OrderStatus;at:string;by:Role}
export interface FoodDetails {restaurantId:string;restaurantName:string;customerName:string;restaurantOperator:string;courierName?:string;items:FoodItem[];subtotal:number;deliveryFee:number;total:number;paymentStatus:'approved'|'cancelled';paymentApprovedAt:string;history:FoodEvent[]}
