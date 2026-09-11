package push

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestTTranslatesAndFallsBack(t *testing.T) {
	if got := T(LangNB, "No feed logged for %s", T(LangNB, "%d h", 4)); got != "Ikke noe måltid logget på 4 t" {
		t.Errorf("nb = %q", got)
	}
	if got := T(LangEN, "No feed logged for %s", T(LangEN, "%d h", 4)); got != "No feed logged for 4 h" {
		t.Errorf("en = %q", got)
	}
	if got := T(LangNB, "Not in the dictionary"); got != "Not in the dictionary" {
		t.Errorf("fallback = %q", got)
	}
}

var verb = regexp.MustCompile(`%[-+# 0]*[0-9]*(?:\.[0-9]+)?[a-zA-Z%]`)

// A translation that drops, adds or reorders a verb would print
// %!s(MISSING) or swap the baby's name for a duration.
func TestNorwegianKeepsTheFormatVerbs(t *testing.T) {
	for en, no := range nb {
		if a, b := verb.FindAllString(en, -1), verb.FindAllString(no, -1); !slices.Equal(a, b) {
			t.Errorf("%q → %q: verbs %v vs %v", en, no, a, b)
		}
	}
}

// Every string a push is written with is translated: the Go counterpart of
// the SPA's i18n coverage check. It reads the packages that send pushes and
// collects the literal format of every T call.
func TestEveryNotificationStringHasNorwegian(t *testing.T) {
	seen := 0
	for _, dir := range []string{".", "../jobs", "../api"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			src, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			file, err := parser.ParseFile(token.NewFileSet(), f, src, 0)
			if err != nil {
				t.Fatal(err)
			}
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) < 2 || !isT(call.Fun) {
					return true
				}
				lit, ok := call.Args[1].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					t.Errorf("%s: T's format must be a string literal, so this test can see it", f)
					return true
				}
				s, _ := strconv.Unquote(lit.Value)
				seen++
				if _, ok := nb[s]; !ok {
					t.Errorf("%s: %q has no Norwegian in text.go", f, s)
				}
				return true
			})
		}
	}
	if seen < 20 {
		t.Errorf("found %d T calls; the scan is not seeing the senders", seen)
	}
}

func isT(fun ast.Expr) bool {
	switch f := fun.(type) {
	case *ast.Ident:
		return f.Name == "T"
	case *ast.SelectorExpr:
		x, ok := f.X.(*ast.Ident)
		return ok && x.Name == "push" && f.Sel.Name == "T"
	}
	return false
}
