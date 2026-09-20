import { Injectable } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}
  list() { return this.prisma.notification.findMany(); }
  markRead(id: number) { return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } }); }
  email(to: string, body: string) { return sgMail.send({ to, from: 'no-reply@nimbus.example', subject: 'Nimbus', text: body }); }
}
