import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class CertificatesService {
  constructor(private prisma: PrismaService) {}
  mine() { return this.prisma.certificate.findMany(); }
  verify(serial: string) { return this.prisma.certificate.findUnique({ where: { serial } }); }
  issue(enrollmentId: number) { return this.prisma.certificate.create({ data: { enrollmentId, serial: 'NB-' + enrollmentId } }); }
}
