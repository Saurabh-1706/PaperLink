/**
 * Authentication and user provisioning. Port of backend/app/modules/auth/service.py.
 */
import { AuthenticationError, ConflictError } from "@/lib/server/errors";
import { UserRepository } from "@/lib/server/db/repositories";
import type { UnitOfWork } from "@/lib/server/db/session";
import { newOrgOwned, newEntity } from "@/lib/server/db/base";
import type { Organization, User } from "@/lib/server/db/models";
import {
  createAccessToken,
  createRefreshToken,
  decodeToken,
  hashPassword,
  verifyPassword,
} from "./security";

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
}

async function issueTokens(userId: string, orgId: string): Promise<TokenPair> {
  const [access_token, refresh_token] = await Promise.all([
    createAccessToken(userId, orgId),
    createRefreshToken(userId, orgId),
  ]);
  return { access_token, refresh_token, token_type: "bearer" };
}

export class AuthService {
  private users: UserRepository;

  constructor(private session: UnitOfWork) {
    this.users = new UserRepository(session);
  }

  async createOrganization(name: string): Promise<Organization> {
    const organization: Organization = { ...newEntity(), name };
    this.session.add("organizations", organization);
    await this.session.flush();
    return organization;
  }

  async createUser(organizationId: string, email: string, password: string): Promise<User> {
    const normalizedEmail = email.toLowerCase();
    if ((await this.users.byEmail(normalizedEmail)) !== null) {
      throw new ConflictError("A user with that email already exists.", { email: normalizedEmail });
    }
    const user: User = {
      ...newOrgOwned(organizationId),
      email: normalizedEmail,
      hashedPassword: await hashPassword(password),
      isActive: true,
    };
    this.users.add(user);
    return user;
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.byEmail(email.toLowerCase());
    // Same error either way: never reveal whether an account exists.
    if (!user || !(await verifyPassword(password, user.hashedPassword))) {
      throw new AuthenticationError("Invalid email or password.");
    }
    return issueTokens(user.id, user.organizationId);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = await decodeToken(refreshToken, "refresh");
    return issueTokens(payload.sub, payload.org);
  }
}
