"""외부 데이터 주소 모음 (키는 여기에 두지 않는다)."""

GENERAL = "https://apis.data.go.kr/1741000/general_restaurants/info"   # 행정안전부_식품_일반음식점 조회서비스
REST = "https://apis.data.go.kr/1741000/rest_cafes/info"               # 행정안전부_식품_휴게음식점 조회서비스
MODEL = "https://apis.data.go.kr/1741000/excellent_restaurant_info/info"  # 행정안전부_모범음식점정보 조회서비스

# 부산광역시_구군 모범음식점 현황 (주소 확인용 후보)
BUSAN_MODEL_CANDIDATES = [
    "https://apis.data.go.kr/6260000/BusanGoodRestaurantService/getGoodRestaurantInfo",
    "https://apis.data.go.kr/6260000/BusanModelRestaurantService/getModelRestaurantInfo",
]

KAKAO_KEYWORD = "https://dapi.kakao.com/v2/local/search/keyword.json"

PAGE_SIZE = 100
