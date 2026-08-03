workspace "GDM Study Platform" "AI-supported group decision-making study" {

    model {
        participant = person "Participant" "Member of a small group (default 3) solving the Moon Survival ranking task"
        researcher  = person "Researcher" "Configures conditions, exports data"

        gdm = softwareSystem "GDM Study Platform" "Runs AI-assisted group decision-making sessions" {

            group "Frontend" {
                spa = container "Participant Client" "Survey & chat screens; renders inline private nudges" "React, matrix-js-sdk"
                admin = container "Admin Dashboard" "Configure conditions, trigger export" "React"
            }

            group "Backend" {
                sessionManager = container "Session Manager" "Instantiates & tracks sessions per condition and study round (how many done / still needed); persists sessions, surveys & messages; serves reports & exports" "NestJS"
                chatService = container "Chat Service" "Runtime glue between the session entity, the bot and Matrix during a session" "NestJS"
                bot = container "Bot / Rule Engine" "Rule-based contribution-share detector; sends group or private nudges. Rule+LLM arms add semantic classification" "Node module inside Chat Service"
                matrix = container "Matrix Server" "Real-time chat; rooms = groups; durable message store; E2EE off on study rooms" "Synapse"
                exportService = container "Export Service" "Future standalone service if exports outgrow Session Manager endpoints" "NestJS"
                db = container "Research Database" "Sessions, surveys, messages, interventions" "PostgreSQL" {
                    tags "Database"
                }
            }
        }

        # External
        llm = softwareSystem "LLM (Anthropic API)" "Semantic contribution classification in the rule+LLM arms" {
            tags "External"
        }

        # --- Relationships (current decisions) ---

        participant -> spa "Uses" "HTTPS"
        researcher -> admin "Uses" "HTTPS"

        spa -> sessionManager "Opens session, submits surveys; receives session object" "HTTPS/JSON"
        spa -> matrix "Real-time chat: messages, ranking edits, typing (no reactions per study protocol)" "Matrix C-S API"

        admin -> sessionManager "Configures & tracks conditions" "HTTPS/JSON"
        admin -> sessionManager "Exports JSON / CSV from research DB" "HTTPS/JSON"

        sessionManager -> chatService "Starts & owns the live session (with assigned condition)"
        chatService -> sessionManager "Returns session entity incl. messages (at session end)"
        sessionManager -> db "Persists sessions, conditions, surveys, messages, rankings and interventions" "SQL"

        sessionManager -> matrix "Provisions rooms & users, invites participants" "Matrix C-S API / Admin API"
        chatService -> matrix "Relays room events into the session entity" "Matrix C-S API"
        chatService -> bot "Provides session context & condition"

        # Bot <-> Matrix is bidirectional: reads the stream, posts nudges
        bot -> matrix "Reads event stream via bot user" "Matrix C-S API (/sync)"
        bot -> matrix "Posts nudges (group / private)" "Matrix C-S API"

        bot -> llm "Classifies message contributions (rule+LLM arms)"

        exportService -> db "Reads for JSON / CSV export" "SQL"

        # NOTE: Synapse also keeps its own internal Postgres (durable message store).
        # It is the fallback if the backend crashes before end-of-session persistence.
        # Omitted here to match the single-DB view of the research store.
    }

    views {
        systemContext gdm "Context" {
            include *
            autolayout lr
        }

        container gdm "Containers" {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Database" {
                shape cylinder
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Optional" {
                background #999999
                color #ffffff
            }
            relationship "Optional" {
                dashed true
                color #999999
            }
        }
    }
}
