import Stripe from 'stripe';
export class PaymentsService { charge() { return new Stripe('k').charges.create({} as any); } }
