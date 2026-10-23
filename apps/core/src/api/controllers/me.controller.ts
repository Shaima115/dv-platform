import { Controller, Get, Inject, Query } from '@nestjs/common';
import { CurrentUser, UserEndpoint, ZodValidationPipe, type UserPrincipal } from '@dv/shared';
import type { GetMeUseCase } from '../../application/use-cases/get-me';
import type { ListMyCompaniesUseCase } from '../../application/use-cases/list-my-companies';
import { pageQuerySchema, type PageQuery } from '../dto/schemas';
import { GET_ME, LIST_MY_COMPANIES } from '../tokens';

@Controller('api/v1/me')
@UserEndpoint()
export class MeController {
  constructor(
    @Inject(GET_ME) private readonly getMe: GetMeUseCase,
    @Inject(LIST_MY_COMPANIES) private readonly listMine: ListMyCompaniesUseCase,
  ) {}

  @Get()
  me(@CurrentUser() user: UserPrincipal) {
    return this.getMe.execute(user);
  }

  @Get('companies')
  companies(
    @CurrentUser() user: UserPrincipal,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageQuery,
  ) {
    return this.listMine.execute(user, page);
  }
}
