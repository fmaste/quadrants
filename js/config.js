/* Deployment settings. */
window.QUADRANTS_CONFIG =
  { // The two axes of the matrix, keyed by the same words the board shows.
    // names[0] is the label actually written when a card moves; the rest are
    // recognised aliases, which is how a team renames a flag without
    // reclassifying anything. colour and description are what the label setup
    // button writes to GitHub, where a description caps at 100 characters.
    labels:
      { urgent:
          { names: ['urgent']
          , color: 'd73a4a'
          , description: 'Waiting makes it worse: someone is blocked, ' +
                         'something is broken, or a date is at stake.'
          }
      , strategic:
          { names: ['strategic', 'important']
          , color: '1d76db'
          , description: 'Moves us toward a goal we have written down. ' +
                         'Name the goal or it is not strategic.'
          }
      }
    // Accent colour per quadrant, overridable per browser in the settings
    // dialog, and never written to GitHub.
  , quadrantColors:
      { now: 'dc3545'
      , ongoing: '0d6efd'
      , respond: 'fd7e14'
      , unsorted: '6c757d'
      }
    // Issues per API request, 1 to 100. One request is one page in a
    // quadrant footer.
  , perPage: 50
  }
;

