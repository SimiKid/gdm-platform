workspace "GDM Study Platform" "AI-supported group decision-making study" {

    model {
        participant = person "Participant" "Member of a 5-person hiring committee"
        researcher  = person "Researcher" "Configures conditions, exports data"

        gdm = softwareSystem "GDM Study Platform" "Runs AI-assisted group decision-making sessions" {

            group "Frontend" {
                spa = container "Participant Client" "Survey & chat screens; renders inline private nudges" "React, matrix-js-sdk"
                admin = container "Admin Dashboard" "Configure conditions, trigger export" "React"
            }

            group "Backend" {
                sessionManager = container "Session Manager" "Instantiates & tracks sessions per condition (how many done / still needed); persists sessions, surveys & messages" "NestJS"
                chatService = container "Chat Service" "Runtime glue between the session entity, the bot and Matrix during a session" "NestJS"
                bot = container "Bot / Rule Engine" "Rule-based contribution-share detector; sends group or private nudges. LLM is optional" "Node appservice"
                matrix = container "Matrix Server" "Real-time chat; rooms = groups; durable message store; E2EE off on study rooms" "Synapse"
                exportService = container "Export Service" "Future standalone service if exports outgrow Session Manager endpoints" "NestJS"
                db = container "Research Database" "Sessions, surveys, messages, interventions" "PostgreSQL" {
                    tags "Database"
                }
            }
        }

        # External, optional, future
        llm = softwareSystem "LLM" "Optional, future: semantic acknowledgment check" {
            tags "External" "Optional"
        }

        # --- Relationships (current decisions) ---

        participant -> spa "Uses" "HTTPS"
        researcher -> admin "Uses" "HTTPS"

        spa -> sessionManager "Opens session, submits surveys; receives session object" "HTTPS/JSON"
        spa -> matrix "Real-time chat: messages, reactions, typing" "Matrix C-S API"

        admin -> sessionManager "Configures & tracks conditions" "HTTPS/JSON"
        admin -> sessionManager "Exports JSON / CSV from research DB" "HTTPS/JSON"

        sessionManager -> chatService "Starts & owns the live session (with assigned condition)"
        chatService -> sessionManager "Returns session entity incl. messages (at session end)"
        sessionManager -> db "Persists sessions, conditions, surveys, messages, rankings and interventions" "SQL"

        chatService -> matrix "Provisions room & users, relays messages into the session entity" "Matrix C-S API / Admin API"
        chatService -> bot "Provides session context & condition"

        # Bot <-> Matrix is bidirectional: reads the stream, posts nudges
        bot -> matrix "Reads event stream" "Appservice API"
        bot -> matrix "Posts nudges (group / private)" "Matrix C-S API"

        bot -> llm "Optional semantic acknowledgment check (future)" {
            tags "Optional"
        }

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
