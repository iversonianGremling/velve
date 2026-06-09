package tree_sitter_velve_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_velve "github.com/tree-sitter/tree-sitter-velve/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_velve.Language())
	if language == nil {
		t.Errorf("Error loading Velve grammar")
	}
}
