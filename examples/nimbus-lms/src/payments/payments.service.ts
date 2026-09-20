import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class PaymentsService {
  private stripe = new Stripe(process.env.STRIPE_KEY ?? '');
  constructor(private prisma: PrismaService) {}
  checkout(dto: any) { return this.stripe.checkout.sessions.create(dto); }
  handleWebhook(event: any) { return this.prisma.payment.create({ data: event.data }); }
  list() { return this.prisma.payment.findMany(); }
  receipt(id: number) { return this.prisma.payment.findUnique({ where: { id } }); }
}
