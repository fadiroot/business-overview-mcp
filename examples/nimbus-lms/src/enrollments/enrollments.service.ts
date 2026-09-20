import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EnrollmentsService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}
  forCurrentStudent() { return this.prisma.enrollment.findMany(); }
  enrol(dto: any) { return this.prisma.enrollment.create({ data: dto }); }
  list() { return this.prisma.enrollment.findMany(); }
  refund(id: number) { return this.prisma.enrollment.update({ where: { id }, data: { status: 'REFUNDED' } }); }
  byCourse(courseId: number) { return this.prisma.enrollment.findMany({ where: { courseId } }); }
}
