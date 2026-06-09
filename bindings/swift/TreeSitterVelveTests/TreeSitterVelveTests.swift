import XCTest
import SwiftTreeSitter
import TreeSitterVelve

final class TreeSitterVelveTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_velve())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading Velve grammar")
    }
}
