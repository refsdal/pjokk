package api

import "testing"

func TestUpsizeGoogleAvatar(t *testing.T) {
	cases := map[string]string{
		"https://lh3.googleusercontent.com/a/abc=s96-c": "https://lh3.googleusercontent.com/a/abc=s512-c",
		"https://lh3.googleusercontent.com/a/abc":        "https://lh3.googleusercontent.com/a/abc",
	}
	for in, want := range cases {
		if got := upsizeGoogleAvatar(in); got != want {
			t.Errorf("upsizeGoogleAvatar(%q) = %q, want %q", in, got, want)
		}
	}
}
