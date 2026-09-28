# import os
# from dotenv import load_dotenv
# from openai import OpenAI

# load_dotenv()
# client = OpenAI(
#     api_key=os.environ["NEBIUS_API_KEY"],
#     base_url="https://api.tokenfactory.nebius.com/v1/",
# )

# # 1) See which Nemotron models exist for your account
# for m in client.models.list().data:
#     if "nemotron" in m.id.lower():
#         print(m.id)

# # 2) Call one
# r = client.chat.completions.create(
#     model="nvidia/nemotron-3-super-120b-a12b",  # ID from the starter repo; confirm against the list above
#     messages=[{"role": "user", "content": "Convert this jQuery to React: $('#btn').on('click', () => alert('hi'))"}],
# )
# print(r.choices[0].message.content)
















# import os

# from dotenv import load_dotenv
# from tavily import TavilyClient

# load_dotenv()
# t = TavilyClient(os.environ["TAVILY_API_KEY"])
# res = t.search("jQuery to React migration guide", max_results=3)
# print(res)