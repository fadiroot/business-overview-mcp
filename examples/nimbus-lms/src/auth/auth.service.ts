import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}
  register(dto: any) { return this.prisma.user.create({ data: dto }); }
  login(dto: any) { return this.prisma.user.findUnique({ where: { email: dto.email } }); }
  me() { return this.prisma.user.findFirst({ include: { profile: true } }); }
  updateProfile(dto: any) { return this.prisma.profile.update({ where: { userId: dto.userId }, data: dto }); }
}
