**Input**

Resume

Context (personal, work history, projects, etc.)

Job Link

**Resume Creation**

Stage 1: Keywords are extracted, reccomendations to change made.

Stage 2: Latex is edited and created. Gemini-3.5 flash checks for visual deformities. Optional human check.

Stage 3: Resume is created. End of resume creation.

**Application**

Stage 1: Agent uses browser use to look up job. fills out personal data from context. Writes job description answers with prompt + context. human does a final check, prompts it with aditional context. 

If the information isn't availble, model makes a tool call to pause the session and ask the human for more info which is also added to informational markdown document (can probably store this in another DB).

For questions, machine writes the answers. potentially use my personal finetuned gemma for the actual writing, machine for structure. preload anecdotes and stories in to automate this.

Job is submitted and added to resume.

when applicable, use the xyz format in the resume. look up more resume tips for construction of the resume, star, etc.
