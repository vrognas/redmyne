import { describe, it, expect } from 'vitest';

describe('URL handling', () => {
  it('should parse http URL', () => {
    const url = new URL('http://example.com');
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('example.com');
  });

  it('should parse URL with port', () => {
    const url = new URL('http://example.com:8080');
    expect(url.port).toBe('8080');
  });

  it('should parse URL with path', () => {
    const url = new URL('https://example.com:8443/redmine');
    expect(url.pathname).toBe('/redmine');
  });

  it('should throw on invalid URL', () => {
    expect(() => new URL('not-a-url')).toThrow();
  });
});
