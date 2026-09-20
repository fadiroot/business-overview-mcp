import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class LessonsService {
  constructor(private prisma: PrismaService) {}
  list(moduleId: number) { return this.prisma.lesson.findMany({ where: { moduleId } }); }
  stream(id: number) { return this.prisma.lesson.findUnique({ where: { id } }); }
  create(dto: any) { return this.prisma.lesson.create({ data: dto }); }
  remove(id: number) { return this.prisma.lesson.delete({ where: { id } }); }
}
