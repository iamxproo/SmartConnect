// Channels and conversations side by side for the collaboration features (threads, reactions, mentions, read state,
// saved messages): the REAL messaging service, a fake workspace service and a fake organization service.
import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { vi } from 'vitest';
import {
  RealtimePublisher,
  type RealtimeChange,
} from '../../../../smartconnect-backend/services/messaging/src/events/realtime-publisher.js';
import { startWorld, type Member, type World } from './conversations.js';
import { Chan, tokenFor, type Visibility } from './messaging.js';

export interface ChannelEvent {
  type: RealtimeChange;
  channelId: string;
  messageId: string;
}

export interface Collab extends World {
  /** Channel events as published after commit. */
  channelEvents: ChannelEvent[];
}

export async function startCollab(env: Record<string, string> = {}): Promise<Collab> {
  const world = await startWorld(undefined, env);
  const channelEvents: ChannelEvent[] = [];
  vi.spyOn(world.svc.app.get(RealtimePublisher), 'publish').mockImplementation((type, _actor, channel, messageId) => {
    channelEvents.push({ type, channelId: channel.channelId, messageId });
  });
  return { ...world, channelEvents };
}

/** One person addressing any messaging route as themselves. */
export class Person {
  constructor(
    private readonly world: World,
    readonly orgId: string,
    readonly userId: string,
  ) {}

  async call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object): Promise<Response> {
    const req = request(this.world.svc.server)[method](url);
    req.set('Authorization', `Bearer ${await tokenFor(this.userId)}`);
    return body === undefined ? req : req.send(body);
  }

  get = (url: string) => this.call('get', url);
  post = (url: string, body?: object) => this.call('post', url, body);
  put = (url: string, body?: object) => this.call('put', url, body);
  patch = (url: string, body?: object) => this.call('patch', url, body);
  delete = (url: string) => this.call('delete', url);

  saved = (qs = '') => this.get(`/api/v1/orgs/${this.orgId}/saved-messages${qs}`);
}

/** A channel, its people and their routes. */
export class Channel {
  readonly chan = new Chan();
  constructor(private readonly world: World) {}

  /** A person who belongs to the organization and the channel (may post), or only reads it. */
  person(access: 'member' | 'admin' | 'reader' = 'member'): Person {
    const person = new Person(this.world, this.chan.orgId, randomUUID());
    this.world.org.addMember(this.chan.orgId, person.userId);
    const visibility: Visibility =
      access === 'reader' ? { isMember: false, myRole: null } : { isMember: true, myRole: access };
    this.world.svc.workspace.show(this.chan, person.userId, visibility);
    return person;
  }

  hide(person: Person): void {
    this.world.svc.workspace.hide(this.chan, person.userId);
  }

  path = (suffix = '') => this.chan.path(suffix);
}

export const asPerson = (world: World, member: Member): Person => new Person(world, member.orgId, member.userId);

/** The message routes of one place, so that the same scenario runs on a channel and on a group conversation. */
export interface Place {
  kind: 'channel' | 'group';
  alice: Person;
  bob: Person;
  /** In the organization, but without access to the place. */
  outsider: Person;
  /** `/messages` routes of the place. */
  path(suffix?: string): string;
  /** Takes the person's access away (channel: hidden by the workspace service; group: removed by the admin). */
  revoke(person: Person): Promise<void>;
}

export async function makePlace(world: World, kind: Place['kind']): Promise<Place> {
  if (kind === 'channel') {
    const channel = new Channel(world);
    const [alice, bob] = [channel.person(), channel.person()];
    const outsider = new Person(world, channel.chan.orgId, randomUUID());
    world.org.addMember(channel.chan.orgId, outsider.userId);
    return { kind, alice, bob, outsider, path: channel.path, revoke: (p) => Promise.resolve(channel.hide(p)) };
  }
  const orgId = world.newOrg();
  const [a, b, c, o] = [world.member(orgId), world.member(orgId), world.member(orgId), world.member(orgId)] as [
    Member,
    Member,
    Member,
    Member,
  ];
  const id = await a.group([b, c]);
  return {
    kind,
    alice: asPerson(world, a),
    bob: asPerson(world, b),
    outsider: asPerson(world, o),
    path: (suffix = '') => `/api/v1/orgs/${orgId}/conversations/${id}/messages${suffix}`,
    revoke: async (p) => {
      await a.delete(`/${id}/participants/${p.userId}`);
    },
  };
}
