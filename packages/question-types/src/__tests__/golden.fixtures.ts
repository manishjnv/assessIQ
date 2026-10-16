// Literal expected hook outputs, one entry per input in fixtures.ts order. Regenerate only on an intentional hook change (see README).
export const GOLDEN: Record<string, { candidateView: unknown[]; guidanceText: unknown[]; deterministicScore?: unknown[][]; isAttempted?: boolean[]; deterministicMarks?: unknown[][] }> = {
 "mcq": {
  "candidateView": [
   {
    "question": "Which port is HTTPS?",
    "options": [
     "80",
     "443",
     "22",
     "25"
    ]
   },
   {
    "question": "Pick one",
    "options": [
     "a",
     "b"
    ]
   },
   {
    "question": "No key",
    "options": [
     "a",
     "b",
     "c",
     "d"
    ]
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Which port is HTTPS?",
   "Pick one",
   "No key",
   ""
  ],
  "deterministicScore": [
   [
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  "isAttempted": [
   true,
   true,
   true,
   false,
   false,
   false,
   false,
   true
  ],
  "deterministicMarks": [
   [
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ]
  ]
 },
 "subjective": {
  "candidateView": [
   {
    "question": "Explain least privilege."
   },
   {
    "question": "Explain RLS."
   },
   {},
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Explain least privilege.",
   "Explain RLS.",
   "",
   ""
  ]
 },
 "kql": {
  "candidateView": [
   {
    "question": "Failed logons",
    "tables": [
     "SigninLogs"
    ]
   },
   {
    "question": "q",
    "tables": [
     "A",
     "B"
    ]
   },
   {
    "question": "q"
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Failed logons",
   "q",
   "q",
   ""
  ]
 },
 "scenario": {
  "candidateView": [
   {
    "title": "Phish",
    "intro": "A user clicked.",
    "step_dependency": "linear",
    "steps": [
     {
      "prompt": "First action?",
      "type": "mcq",
      "id": "s1",
      "options": [
       "isolate",
       "ignore"
      ]
     },
     {
      "prompt": "Write the report"
     },
     {
      "prompt": "Hunt"
     }
    ]
   },
   {
    "title": "Gen",
    "intro": "i",
    "steps": [
     {
      "prompt": "p1"
     },
     {
      "prompt": "p2"
     },
     "plain",
     null
    ]
   },
   {
    "title": "No steps",
    "intro": "i"
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Phish\nA user clicked.\nFirst action?\nWrite the report\nHunt",
   "Gen\ni\np1\np2",
   "No steps\ni",
   ""
  ]
 },
 "log_analysis": {
  "candidateView": [
   {
    "question": "Find the attacker",
    "log_format": "syslog",
    "log_excerpt": "line1\nline2",
    "hint": "h"
   },
   {
    "question": "q",
    "log_format": "json",
    "log_excerpt": "{}"
   },
   {
    "question": "q"
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Find the attacker\nsyslog",
   "q\njson",
   "q",
   ""
  ]
 },
 "numeric": {
  "candidateView": [
   {
    "question": "2+2",
    "unit": "u"
   },
   {
    "question": "pi"
   },
   {
    "question": "bad"
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "2+2",
   "pi",
   "bad",
   ""
  ],
  "deterministicScore": [
   [
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  "isAttempted": [
   true,
   true,
   true,
   true,
   true,
   true,
   false,
   true,
   true,
   true
  ],
  "deterministicMarks": [
   [
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ]
  ]
 },
 "multi_select": {
  "candidateView": [
   {
    "question": "Pick two",
    "options": [
     "a",
     "b",
     "c",
     "d",
     "e"
    ]
   },
   {
    "question": "Pick",
    "options": [
     "a",
     "b",
     "c"
    ]
   },
   {
    "question": "bad",
    "options": [
     "a",
     "b"
    ]
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Pick two",
   "Pick",
   "bad",
   ""
  ],
  "deterministicScore": [
   [
    1,
    1,
    0.5,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  "isAttempted": [
   true,
   true,
   true,
   true,
   false,
   true,
   false,
   false,
   true,
   true
  ],
  "deterministicMarks": [
   [
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 2,
     "max": 4,
     "status": "partial"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ]
  ]
 },
 "ordering": {
  "candidateView": [
   {
    "question": "Order",
    "items": [
     "a",
     "b",
     "c",
     "d"
    ]
   },
   {
    "question": "Order2",
    "items": [
     "x",
     "y"
    ]
   },
   {
    "question": "bad",
    "items": [
     "x",
     "y"
    ]
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "Order",
   "Order2",
   "bad",
   ""
  ],
  "deterministicScore": [
   [
    1,
    0,
    0.5,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    1,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  "isAttempted": [
   true,
   true,
   true,
   true,
   false,
   false,
   true
  ],
  "deterministicMarks": [
   [
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 2,
     "max": 4,
     "status": "partial"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    }
   ]
  ]
 },
 "structured_case": {
  "candidateView": [
   {
    "title": "Case",
    "context": "ctx",
    "log_excerpt": "log",
    "steps": [
     {
      "id": "a",
      "prompt": "p",
      "select": "one",
      "options": [
       "x",
       "y",
       "z"
      ]
     },
     {
      "id": "b",
      "prompt": "q",
      "select": "many",
      "options": [
       "x",
       "y",
       "z"
      ]
     }
    ]
   },
   {
    "title": "Case2",
    "context": "ctx",
    "steps": [
     {
      "id": "a",
      "prompt": "p",
      "select": "one",
      "options": [
       "x",
       "y"
      ]
     }
    ]
   },
   {
    "title": "Case3",
    "context": "c",
    "steps": [
     {
      "id": undefined,
      "prompt": undefined,
      "select": undefined,
      "options": undefined
     },
     {
      "id": "z",
      "prompt": undefined,
      "select": undefined,
      "options": undefined
     }
    ]
   },
   null,
   "str",
   [
    1
   ]
  ],
  "guidanceText": [
   "",
   "",
   "",
   ""
  ],
  "deterministicScore": [
   [
    1,
    0.75,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  "isAttempted": [
   true,
   true,
   true,
   true,
   true,
   true,
   false,
   false
  ],
  "deterministicMarks": [
   [
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 3,
     "max": 4,
     "status": "partial"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -0.5,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -0.5,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 4,
     "max": 4,
     "status": "correct"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": -1,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    }
   ],
   [
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    },
    {
     "earned": 0,
     "max": 4,
     "status": "incorrect"
    }
   ]
  ]
 }
};
