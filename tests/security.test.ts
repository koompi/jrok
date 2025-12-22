/**
 * Security Tests for Jrok
 * Tests critical security features
 */

describe("Input Validation", () => {
  test("should reject invalid domain names", () => {
    const validDomains = ["test", "test-app", "test123"];
    const invalidDomains = ["test.", "-test", "test_", "test!", "../etc"];
    
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    
    validDomains.forEach(domain => {
      expect(domainRegex.test(domain)).toBe(true);
    });
    
    invalidDomains.forEach(domain => {
      expect(domainRegex.test(domain)).toBe(false);
    });
  });
});

export {};
