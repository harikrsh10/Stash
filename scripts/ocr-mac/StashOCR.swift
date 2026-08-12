// Reads text out of an image using Apple's Vision framework and prints it as
// JSON: { width, height, words: [{ text, x0, y0, x1, y1 }] }.
//
// Word boxes, not line boxes. Stash splits a visual line wherever the gap is
// far wider than ordinary word spacing, which is how side-by-side cards stay
// separate blocks — that needs per-word geometry. Vision gives line
// observations, so each word's range is mapped back to its own box.
//
// Vision reports boxes in normalized coordinates with the origin at the
// bottom-left; everything downstream works in top-left pixels, so they are
// converted here rather than in three places later.
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Word: Encodable {
    let text: String
    // which line Vision put this word on. Stash groups by this rather than
    // re-deriving lines from geometry, which goes wrong on letter-spaced type.
    let line: Int
    let x0: Int
    let y0: Int
    let x1: Int
    let y1: Int
}

struct Output: Encodable {
    let width: Int
    let height: Int
    let words: [Word]
}

struct Failure: Encodable {
    let error: String
}

func fail(_ message: String) -> Never {
    let data = try! JSONEncoder().encode(Failure(error: message))
    FileHandle.standardOutput.write(data)
    exit(0)
}

guard CommandLine.arguments.count > 1 else { fail("no image given") }
let path = CommandLine.arguments[1]

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("could not open that image")
}

let width = image.width
let height = image.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// screenshots are full of product names and identifiers that a language model
// would happily "correct" into something else
request.usesLanguageCorrection = false
if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = false
}
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("could not read that image")
}

var words: [Word] = []
var lineIndex = 0

// results are already text observations; casting them warned as always-true
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string
    defer { lineIndex += 1 }

    // walk the string word by word and ask Vision where each one sits
    var index = text.startIndex
    while index < text.endIndex {
        if text[index].isWhitespace {
            index = text.index(after: index)
            continue
        }
        var end = index
        while end < text.endIndex && !text[end].isWhitespace {
            end = text.index(after: end)
        }
        let range = index..<end
        let piece = String(text[range])

        // `try?` already flattens the optional the API returns, so binding it a
        // second time is what failed to compile
        var box = observation.boundingBox
        if let quad = try? candidate.boundingBox(for: range) {
            box = quad.boundingBox
        }

        // normalized, bottom-left origin -> pixels, top-left origin
        let x0 = Int((box.minX * CGFloat(width)).rounded())
        let x1 = Int((box.maxX * CGFloat(width)).rounded())
        let y0 = Int(((1 - box.maxY) * CGFloat(height)).rounded())
        let y1 = Int(((1 - box.minY) * CGFloat(height)).rounded())

        if x1 > x0 && y1 > y0 && !piece.isEmpty {
            words.append(Word(text: piece, line: lineIndex, x0: x0, y0: y0, x1: x1, y1: y1))
        }
        index = end
    }
}

let encoder = JSONEncoder()
let data = try encoder.encode(Output(width: width, height: height, words: words))
FileHandle.standardOutput.write(data)
