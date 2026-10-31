import unittest

from app.security import create_access_token, decode_access_token, hash_password, verify_password


class SecurityTests(unittest.TestCase):
    def test_password_hash_is_not_reversible_plaintext(self):
        encoded = hash_password("correct horse battery staple")
        self.assertNotEqual(encoded, "correct horse battery staple")
        self.assertTrue(verify_password("correct horse battery staple", encoded))
        self.assertFalse(verify_password("wrong password", encoded))


    def test_access_token_contains_identity_and_role(self):
        token = create_access_token("42", "owner")
        payload = decode_access_token(token)
        self.assertEqual(payload["sub"], "42")
        self.assertEqual(payload["role"], "owner")


if __name__ == "__main__":
    unittest.main()
