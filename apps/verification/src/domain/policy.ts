/**
 * Verification's authorization policy, deny by default. Deciding requires the platform role
 * `reviewer` from the verified token. Owning the company grants nothing here.
 */
export type VerificationAction = 'verification:decide';

export interface VerificationActor {
  kind: 'user' | 'service';
  platformRoles: ReadonlySet<string>;
}

export function mayPerform(action: VerificationAction, actor: VerificationActor): boolean {
  switch (action) {
    case 'verification:decide':
      return actor.kind === 'user' && actor.platformRoles.has('reviewer');
    default:
      return false;
  }
}
