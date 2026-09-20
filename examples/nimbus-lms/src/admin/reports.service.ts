import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}
  revenue() { return this.prisma.payment.aggregate({ _sum: { amountCents: true } }); }
  enrollments() { return this.prisma.enrollment.groupBy({ by: ['status'] }); }
  instructorPayouts() { return this.prisma.course.findMany({ include: { enrollments: true } }); }
}
