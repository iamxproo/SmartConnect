import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { ProbeModule } from './support/probe.module.js';

const ECHO = '/api/v1/__probe/echo';

describe('malformed and unsupported request bodies', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  const postRaw = (contentType: string, body: string | Buffer) =>
    request(gateway.server).post(ECHO).set('Content-Type', contentType).send(body);

  it.each(['{"name":', '{name: "General"}', "{'name':'General'}", '{"name":"General"}}'])(
    'answers malformed JSON %j with 400 malformed_json',
    async (body) => {
      const res = await postRaw('application/json', body).expect(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemOf(res)).toMatchObject({
        status: 400,
        code: 'malformed_json',
        detail: 'The request body is not valid JSON.',
        instance: ECHO,
      });
      expect(problemOf(res).requestId).toBeTruthy();
    },
  );

  it.each(['null', '42', '"text"', 'true'])('rejects the non-object JSON top level %s (strict mode)', async (body) => {
    const res = await postRaw('application/json', body).expect(400);
    expect(problemOf(res).code).toBe('malformed_json');
  });

  it('rejects bodies over 1 MB with 413', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(1024 * 1024) });
    const res = await postRaw('application/json', big).expect(413);
    expect(problemOf(res)).toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  it.each([
    ['text/plain', 'name=General'],
    ['application/x-www-form-urlencoded', 'name=General'],
    ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nGeneral\r\n--x--'],
    ['application/xml', '<name>General</name>'],
  ])('rejects %s bodies with 415', async (contentType, body) => {
    const res = await postRaw(contentType, body).expect(415);
    expect(problemOf(res)).toMatchObject({ status: 415, code: 'unsupported_media_type' });
  });

  it('rejects a body without a Content-Type with 415', async () => {
    const res = await request(gateway.server)
      .post(ECHO)
      .set('Content-Length', '19')
      .send(Buffer.from('{"name":"General"}\n'))
      .unset('Content-Type')
      .expect(415);
    expect(problemOf(res).code).toBe('unsupported_media_type');
  });

  it('rejects non-UTF-8 JSON with 415', async () => {
    const res = await postRaw('application/json; charset=latin1', '{"name":"General"}').expect(415);
    expect(problemOf(res).detail).toBe('Only UTF-8 encoded JSON request bodies are supported.');
  });

  it('parses structured-syntax JSON types such as application/merge-patch+json', async () => {
    const res = await postRaw('application/merge-patch+json', '{"name":"General"}').expect(200);
    expect(res.body).toMatchObject({ received: { name: 'General' } });
  });
});
