import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PaymentsService } from '../payments/payments.service';
@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService, private payments: PaymentsService) {}
  findAll() { return this.prisma.order.findMany(); }
  findOne(id: number) { return this.prisma.order.findUnique({ where: { id } }); }
  create(dto: any) { return this.prisma.order.create({ data: dto }); }
  approve(id: number) { return this.prisma.order.update({ where: { id }, data: { status: 'APPROVED' } }); }
  remove(id: number) { return this.prisma.order.delete({ where: { id } }); }
  track(code: string) { return this.prisma.order.findFirst({ where: { status: code } }); }
}
